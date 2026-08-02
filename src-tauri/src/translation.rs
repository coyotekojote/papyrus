//! Translating a selection through one of the API providers (issue #10).
//!
//! The call is made here rather than in the WebView for two reasons: the API
//! key stays on this side of the IPC boundary (see `keychain.rs`), and a
//! browser `fetch` to another origin would need CORS the providers do not
//! grant.
//!
//! A provider is split into three pure pieces — build the request, read a
//! successful body, read a failed one — with the HTTP send left outside the
//! trait. That way every provider is tested against recorded payloads without
//! a network, a mock server, or an API key.

use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::keychain::{self, KeychainError, OsKeychain};
use crate::settings::{self, Settings, SettingsError, TranslationProvider as ProviderId};

/// Longest selection accepted, in characters.
///
/// Well past a paragraph, and short enough that one request stays quick and
/// cheap. A reader who selects half a chapter gets told so rather than waiting.
pub const MAX_TEXT_CHARS: usize = 4000;

/// How much text on each side is passed along as context. Context is a hint,
/// not the subject, so an over-long one is trimmed rather than refused.
pub const MAX_CONTEXT_CHARS: usize = 800;

/// Ceiling on the translated output for providers that want one. Generous
/// relative to `MAX_TEXT_CHARS`: a translation can be several times longer
/// than its source, and being cut off mid-sentence is worse than the tokens.
const MAX_OUTPUT_TOKENS: u32 = 8192;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

const ANTHROPIC_VERSION: &str = "2023-06-01";

/// The model each provider is called with when the reader has not chosen one.
/// None for a provider whose model ids this build will not guess at — asking
/// for one is better than failing later with the provider's own error.
const CLAUDE_DEFAULT_MODEL: &str = "claude-opus-5";

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TranslationError {
    /// Nothing to translate: the selection was blank.
    EmptySelection,
    TextTooLong {
        limit: usize,
    },
    /// The chosen provider has no key in the keychain.
    MissingKey,
    /// The provider takes a model and this build has no default for it.
    ModelRequired,
    /// The key was rejected: wrong, revoked, or out of quota.
    Unauthorized,
    RateLimited,
    /// The provider is down or overloaded; retrying later may work.
    Unavailable {
        status: u16,
    },
    /// The provider refused the request itself — usually a bad model id.
    BadRequest {
        message: String,
    },
    /// The provider declined to translate this text.
    Refused,
    Network {
        message: String,
    },
    /// A 2xx body that did not contain a translation.
    MalformedResponse {
        message: String,
    },
    Keychain {
        message: String,
    },
    Settings {
        message: String,
    },
    /// The blocking half of the work could not be run at all.
    Internal {
        message: String,
    },
}

type Result<T> = std::result::Result<T, TranslationError>;

impl From<KeychainError> for TranslationError {
    fn from(err: KeychainError) -> Self {
        TranslationError::Keychain {
            message: match err {
                KeychainError::Keychain { message } => message,
                other => format!("{other:?}"),
            },
        }
    }
}

impl From<SettingsError> for TranslationError {
    fn from(err: SettingsError) -> Self {
        TranslationError::Settings {
            message: match err {
                SettingsError::ConfigDirUnavailable { message }
                | SettingsError::Serialize { message }
                | SettingsError::Io { message } => message,
            },
        }
    }
}

// --- request / response shapes ---

/// One translation, as the providers are asked for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranslationRequest {
    pub text: String,
    /// Text just before the selection on the page, for disambiguation only.
    pub context_before: String,
    pub context_after: String,
    /// BCP-47 tag to translate into.
    pub target_language: String,
    /// The model to ask for, or None to let the provider decide.
    pub model: Option<String>,
}

impl TranslationRequest {
    /// The request as it is worth sending: selection trimmed and bounded,
    /// context trimmed to the part nearest the selection.
    pub fn prepare(
        text: &str,
        context_before: &str,
        context_after: &str,
        target_language: &str,
        model: Option<String>,
    ) -> Result<Self> {
        let text = text.trim();
        if text.is_empty() {
            return Err(TranslationError::EmptySelection);
        }
        if text.chars().count() > MAX_TEXT_CHARS {
            return Err(TranslationError::TextTooLong {
                limit: MAX_TEXT_CHARS,
            });
        }
        Ok(TranslationRequest {
            text: text.to_string(),
            context_before: keep_tail(context_before, MAX_CONTEXT_CHARS),
            context_after: keep_head(context_after, MAX_CONTEXT_CHARS),
            target_language: target_language.to_string(),
            model,
        })
    }
}

/// The last `limit` characters — the ones next to the selection.
fn keep_tail(text: &str, limit: usize) -> String {
    let count = text.chars().count();
    text.chars().skip(count.saturating_sub(limit)).collect()
}

fn keep_head(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
    /// JSON body, already serialized.
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

/// One translation backend.
///
/// Everything here is pure: no I/O, no clock, no key beyond the one passed in.
pub trait TranslationProvider {
    /// The HTTP call that asks for this translation.
    fn build_request(&self, key: &str, request: &TranslationRequest) -> Result<HttpRequest>;
    /// The translated text inside a successful body.
    fn parse_response(&self, body: &str) -> Result<String>;
    /// The provider's own wording for a failure, when it gave one.
    fn error_message(&self, body: &str) -> Option<String>;
}

pub fn provider_for(id: ProviderId) -> Box<dyn TranslationProvider + Send + Sync> {
    match id {
        ProviderId::Claude => Box::new(Claude),
        ProviderId::Openai => Box::new(Openai),
        ProviderId::Deepl => Box::new(Deepl),
    }
}

// --- shared helpers ---

fn parse_json(body: &str) -> Result<Value> {
    serde_json::from_str(body).map_err(|err| TranslationError::MalformedResponse {
        message: err.to_string(),
    })
}

/// Guards against a provider answering 200 with nothing in it, which would
/// otherwise show up as an empty translation panel.
fn non_empty(text: String) -> Result<String> {
    if text.trim().is_empty() {
        return Err(TranslationError::MalformedResponse {
            message: "翻訳結果が空でした".to_string(),
        });
    }
    Ok(text)
}

fn json_header() -> (String, String) {
    ("content-type".to_string(), "application/json".to_string())
}

/// What the LLM providers are told to do. The context is spelled out as
/// context so the model translates the selection alone: a model handed three
/// paragraphs will otherwise translate all three.
fn system_prompt(target_language: &str) -> String {
    format!(
        "You are a translator built into a PDF reader. Translate the reader's \
selection into the language with BCP-47 tag \"{target_language}\".\n\
- Reply with the translation and nothing else: no preamble, no notes, no \
quotation marks around it, and no tags of any kind.\n\
- Text given as context is there only to disambiguate the selection. Never \
translate it and never include it in your reply.\n\
- Keep technical terms, symbols, numbers and code as they are.\n\
- The selection may begin or end mid-sentence. Translate exactly what is \
there rather than completing it."
    )
}

/// The selection, with whatever context there is around it. The markers keep
/// the boundary explicit, which matters most when the selection ends mid-word.
fn user_prompt(request: &TranslationRequest) -> String {
    let mut prompt = String::new();
    if !request.context_before.trim().is_empty() {
        prompt.push_str(&format!(
            "[context before]\n{}\n\n",
            request.context_before.trim()
        ));
    }
    prompt.push_str(&format!("[selection]\n{}\n", request.text));
    if !request.context_after.trim().is_empty() {
        prompt.push_str(&format!(
            "\n[context after]\n{}\n",
            request.context_after.trim()
        ));
    }
    prompt
}

// --- Claude ---

struct Claude;

impl TranslationProvider for Claude {
    fn build_request(&self, key: &str, request: &TranslationRequest) -> Result<HttpRequest> {
        let model = request.model.as_deref().unwrap_or(CLAUDE_DEFAULT_MODEL);
        let body = json!({
            "model": model,
            "max_tokens": MAX_OUTPUT_TOKENS,
            // Translating a paragraph needs no deliberation, and thinking
            // would be charged against max_tokens as well as the latency the
            // reader waits through.
            "thinking": { "type": "disabled" },
            "system": system_prompt(&request.target_language),
            "messages": [{ "role": "user", "content": user_prompt(request) }],
        });
        Ok(HttpRequest {
            url: "https://api.anthropic.com/v1/messages".to_string(),
            headers: vec![
                ("x-api-key".to_string(), key.to_string()),
                (
                    "anthropic-version".to_string(),
                    ANTHROPIC_VERSION.to_string(),
                ),
                json_header(),
            ],
            body: body.to_string(),
        })
    }

    fn parse_response(&self, body: &str) -> Result<String> {
        let value = parse_json(body)?;
        // Checked before the content: a refused response is a well-formed 200
        // whose content is empty, which would otherwise read as a bad reply.
        if value.get("stop_reason").and_then(Value::as_str) == Some("refusal") {
            return Err(TranslationError::Refused);
        }
        let blocks = value
            .get("content")
            .and_then(Value::as_array)
            .ok_or_else(|| TranslationError::MalformedResponse {
                message: "content がありません".to_string(),
            })?;
        let text: String = blocks
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect();
        non_empty(text)
    }

    fn error_message(&self, body: &str) -> Option<String> {
        parse_json(body)
            .ok()?
            .get("error")?
            .get("message")?
            .as_str()
            .map(str::to_string)
    }
}

// --- OpenAI ---

struct Openai;

impl TranslationProvider for Openai {
    fn build_request(&self, key: &str, request: &TranslationRequest) -> Result<HttpRequest> {
        // No default model: OpenAI's ids change faster than this app ships,
        // and a guessed one fails at translation time rather than where it was
        // chosen. The settings screen offers no suggestions for the same
        // reason (see settings.ts).
        let model = request
            .model
            .as_deref()
            .ok_or(TranslationError::ModelRequired)?;
        // Neither max_tokens nor temperature is sent: newer models reject both
        // outright, and the prompt already asks for the translation alone.
        let body = json!({
            "model": model,
            "messages": [
                { "role": "system", "content": system_prompt(&request.target_language) },
                { "role": "user", "content": user_prompt(request) },
            ],
        });
        Ok(HttpRequest {
            url: "https://api.openai.com/v1/chat/completions".to_string(),
            headers: vec![
                ("authorization".to_string(), format!("Bearer {key}")),
                json_header(),
            ],
            body: body.to_string(),
        })
    }

    fn parse_response(&self, body: &str) -> Result<String> {
        let value = parse_json(body)?;
        let choice = value
            .get("choices")
            .and_then(|choices| choices.get(0))
            .ok_or_else(|| TranslationError::MalformedResponse {
                message: "choices がありません".to_string(),
            })?;
        if choice.get("finish_reason").and_then(Value::as_str) == Some("content_filter") {
            return Err(TranslationError::Refused);
        }
        let text = choice
            .get("message")
            .and_then(|message| message.get("content"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        non_empty(text.to_string())
    }

    fn error_message(&self, body: &str) -> Option<String> {
        parse_json(body)
            .ok()?
            .get("error")?
            .get("message")?
            .as_str()
            .map(str::to_string)
    }
}

// --- DeepL ---

struct Deepl;

/// Free keys carry this suffix and are served by a different host; sending one
/// to the paid host comes back as an authentication failure.
const DEEPL_FREE_SUFFIX: &str = ":fx";

/// DeepL takes its own upper-case language codes, and insists on a regional
/// variant for the languages that have one. Anything it does not know is
/// refused, so an unmapped tag is narrowed to its primary subtag rather than
/// passed through whole.
fn deepl_target_lang(tag: &str) -> String {
    let normalized = tag.replace('_', "-").to_uppercase();
    let mut parts = normalized.split('-');
    let primary = parts.next().unwrap_or_default();
    let region = parts.next().unwrap_or_default();
    match primary {
        // EN and PT need a variant; EN alone is deprecated as a target.
        "EN" => match region {
            "GB" => "EN-GB".to_string(),
            _ => "EN-US".to_string(),
        },
        "PT" => match region {
            "PT" => "PT-PT".to_string(),
            _ => "PT-BR".to_string(),
        },
        "ZH" => match region {
            "HANT" | "TW" | "HK" | "MO" => "ZH-HANT".to_string(),
            "HANS" | "CN" | "SG" => "ZH-HANS".to_string(),
            _ => "ZH".to_string(),
        },
        other => other.to_string(),
    }
}

impl TranslationProvider for Deepl {
    fn build_request(&self, key: &str, request: &TranslationRequest) -> Result<HttpRequest> {
        let host = if key.ends_with(DEEPL_FREE_SUFFIX) {
            "https://api-free.deepl.com"
        } else {
            "https://api.deepl.com"
        };
        let mut body = json!({
            "text": [request.text],
            "target_lang": deepl_target_lang(&request.target_language),
        });
        // DeepL's own context field: influences the translation without being
        // translated. The selection is included, as their documentation shows,
        // so the sentence it sits in stays whole.
        let context = format!(
            "{}{}{}",
            request.context_before, request.text, request.context_after
        );
        if context != request.text {
            body["context"] = Value::String(context);
        }
        Ok(HttpRequest {
            url: format!("{host}/v2/translate"),
            headers: vec![
                ("authorization".to_string(), format!("DeepL-Auth-Key {key}")),
                json_header(),
            ],
            body: body.to_string(),
        })
    }

    fn parse_response(&self, body: &str) -> Result<String> {
        let value = parse_json(body)?;
        let text = value
            .get("translations")
            .and_then(|translations| translations.get(0))
            .and_then(|translation| translation.get("text"))
            .and_then(Value::as_str)
            .ok_or_else(|| TranslationError::MalformedResponse {
                message: "translations がありません".to_string(),
            })?;
        non_empty(text.to_string())
    }

    fn error_message(&self, body: &str) -> Option<String> {
        parse_json(body)
            .ok()?
            .get("message")?
            .as_str()
            .map(str::to_string)
    }
}

// --- sending ---

/// Turns an HTTP outcome into either the translation or an error the reader
/// can act on. Kept apart from the send so it can be tested against recorded
/// responses.
pub fn interpret(provider: &dyn TranslationProvider, response: &HttpResponse) -> Result<String> {
    match response.status {
        200..=299 => provider.parse_response(&response.body),
        // 456 is DeepL's "quota exhausted", which is the same dead end for the
        // reader as a rejected key: nothing works until they go and fix it.
        401 | 403 | 456 => Err(TranslationError::Unauthorized),
        429 => Err(TranslationError::RateLimited),
        status @ 500..=599 => Err(TranslationError::Unavailable { status }),
        _ => Err(TranslationError::BadRequest {
            message: provider
                .error_message(&response.body)
                .unwrap_or_else(|| format!("HTTP {}", response.status)),
        }),
    }
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .unwrap_or_default()
    })
}

async fn send(request: HttpRequest) -> Result<HttpResponse> {
    let mut builder = client().post(&request.url).body(request.body);
    for (name, value) in &request.headers {
        builder = builder.header(name, value);
    }
    let response = builder
        .send()
        .await
        .map_err(|err| TranslationError::Network {
            message: err.to_string(),
        })?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .map_err(|err| TranslationError::Network {
            message: err.to_string(),
        })?;
    Ok(HttpResponse { status, body })
}

// --- Tauri command ---

/// One finished translation, with what produced it: the panel says which
/// provider answered, and the note it is inserted into records the language.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Translation {
    pub text: String,
    pub provider: String,
    pub model: Option<String>,
    pub target_language: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateArgs {
    pub text: String,
    #[serde(default)]
    pub context_before: String,
    #[serde(default)]
    pub context_after: String,
}

/// The settings and the key for the provider they name.
///
/// Both are blocking reads — a file, then the OS keychain — so they are done
/// together off the async runtime.
fn provider_credentials(app: &tauri::AppHandle) -> Result<(Settings, Option<String>)> {
    let settings = settings::load_settings(app.clone())?;
    let key = keychain::api_key_in(&OsKeychain, settings.translation.provider)?;
    Ok((settings, key))
}

#[tauri::command]
pub async fn translate(app: tauri::AppHandle, request: TranslateArgs) -> Result<Translation> {
    let (settings, key) = tauri::async_runtime::spawn_blocking(move || provider_credentials(&app))
        .await
        .map_err(|err| TranslationError::Internal {
            message: err.to_string(),
        })??;

    let key = key.ok_or(TranslationError::MissingKey)?;
    let provider_id = settings.translation.provider;
    let model = settings
        .translation
        .models
        .get(provider_id.id())
        .filter(|model| !model.is_empty())
        .cloned();

    let prepared = TranslationRequest::prepare(
        &request.text,
        &request.context_before,
        &request.context_after,
        &settings.translation.target_language,
        model.clone(),
    )?;

    let provider = provider_for(provider_id);
    let http = provider.build_request(&key, &prepared)?;
    let response = send(http).await?;
    let text = interpret(provider.as_ref(), &response)?;

    Ok(Translation {
        text,
        provider: provider_id.id().to_string(),
        model,
        target_language: prepared.target_language,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> TranslationRequest {
        TranslationRequest {
            text: "Attention is all you need.".to_string(),
            context_before: "In this work we propose the Transformer. ".to_string(),
            context_after: " We show that it trains faster.".to_string(),
            target_language: "ja".to_string(),
            model: None,
        }
    }

    fn body_of(request: &HttpRequest) -> Value {
        serde_json::from_str(&request.body).expect("body is not JSON")
    }

    fn header<'a>(request: &'a HttpRequest, name: &str) -> Option<&'a str> {
        request
            .headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    // --- preparing ---

    #[test]
    fn preparing_trims_the_selection_and_refuses_a_blank_one() {
        let prepared = TranslationRequest::prepare("  hello  ", "", "", "ja", None).unwrap();
        assert_eq!(prepared.text, "hello");

        for blank in ["", "   ", "\n\t"] {
            assert_eq!(
                TranslationRequest::prepare(blank, "", "", "ja", None),
                Err(TranslationError::EmptySelection),
                "blank: {blank:?}",
            );
        }
    }

    #[test]
    fn preparing_refuses_a_selection_past_the_limit_counting_characters() {
        // Multi-byte on purpose: the limit is characters, not bytes, so this
        // is well inside it despite being three times the length in bytes.
        let japanese = "あ".repeat(MAX_TEXT_CHARS);
        assert!(TranslationRequest::prepare(&japanese, "", "", "ja", None).is_ok());

        let too_long = "あ".repeat(MAX_TEXT_CHARS + 1);
        assert_eq!(
            TranslationRequest::prepare(&too_long, "", "", "ja", None),
            Err(TranslationError::TextTooLong {
                limit: MAX_TEXT_CHARS
            }),
        );
    }

    #[test]
    fn preparing_keeps_the_context_nearest_the_selection() {
        let before = format!("{}near-before", "x".repeat(MAX_CONTEXT_CHARS));
        let after = format!("near-after{}", "y".repeat(MAX_CONTEXT_CHARS));

        let prepared = TranslationRequest::prepare("text", &before, &after, "ja", None).unwrap();

        assert_eq!(prepared.context_before.chars().count(), MAX_CONTEXT_CHARS);
        assert!(prepared.context_before.ends_with("near-before"));
        assert_eq!(prepared.context_after.chars().count(), MAX_CONTEXT_CHARS);
        assert!(prepared.context_after.starts_with("near-after"));
    }

    // --- prompt ---

    #[test]
    fn the_prompt_marks_the_selection_off_from_its_context() {
        let prompt = user_prompt(&request());
        assert!(prompt.contains("[context before]"));
        assert!(prompt.contains("[selection]\nAttention is all you need."));
        assert!(prompt.contains("[context after]"));
    }

    #[test]
    fn the_prompt_omits_context_sections_that_are_empty() {
        let prompt = user_prompt(&TranslationRequest {
            context_before: String::new(),
            context_after: "   ".to_string(),
            ..request()
        });
        assert!(!prompt.contains("[context before]"));
        assert!(!prompt.contains("[context after]"));
        assert!(prompt.contains("[selection]"));
    }

    // --- Claude ---

    #[test]
    fn claude_posts_to_the_messages_endpoint_with_the_key_in_its_header() {
        let http = Claude.build_request("sk-ant-123", &request()).unwrap();

        assert_eq!(http.url, "https://api.anthropic.com/v1/messages");
        assert_eq!(header(&http, "x-api-key"), Some("sk-ant-123"));
        assert_eq!(header(&http, "anthropic-version"), Some(ANTHROPIC_VERSION));
        assert_eq!(header(&http, "content-type"), Some("application/json"));
    }

    #[test]
    fn claude_sends_the_default_model_until_one_is_chosen() {
        let http = Claude.build_request("k", &request()).unwrap();
        assert_eq!(body_of(&http)["model"], CLAUDE_DEFAULT_MODEL);

        let chosen = Claude
            .build_request(
                "k",
                &TranslationRequest {
                    model: Some("claude-haiku-4-5".to_string()),
                    ..request()
                },
            )
            .unwrap();
        assert_eq!(body_of(&chosen)["model"], "claude-haiku-4-5");
    }

    #[test]
    fn claude_asks_for_no_thinking_and_omits_sampling_parameters() {
        let body = body_of(&Claude.build_request("k", &request()).unwrap());

        assert_eq!(body["thinking"]["type"], "disabled");
        // Rejected outright by the current models; sending one fails the call.
        assert!(body.get("temperature").is_none());
        assert!(body.get("top_p").is_none());
    }

    #[test]
    fn claude_passes_the_target_language_and_the_context() {
        let body = body_of(&Claude.build_request("k", &request()).unwrap());

        assert!(body["system"].as_str().unwrap().contains("\"ja\""));
        let content = body["messages"][0]["content"].as_str().unwrap();
        assert!(content.contains("we propose the Transformer"));
        assert!(content.contains("trains faster"));
    }

    #[test]
    fn claude_reads_the_translation_out_of_the_content_blocks() {
        let body = r#"{
            "stop_reason": "end_turn",
            "content": [{ "type": "text", "text": "必要なのは注意だけ。" }]
        }"#;
        assert_eq!(Claude.parse_response(body).unwrap(), "必要なのは注意だけ。");
    }

    #[test]
    fn claude_joins_split_text_blocks_and_ignores_other_kinds() {
        let body = r#"{
            "content": [
                { "type": "thinking", "thinking": "" },
                { "type": "text", "text": "必要なのは" },
                { "type": "text", "text": "注意だけ。" }
            ]
        }"#;
        assert_eq!(Claude.parse_response(body).unwrap(), "必要なのは注意だけ。");
    }

    #[test]
    fn claude_reports_a_refusal_rather_than_an_empty_translation() {
        let body = r#"{ "stop_reason": "refusal", "content": [] }"#;
        assert_eq!(Claude.parse_response(body), Err(TranslationError::Refused));
    }

    #[test]
    fn claude_reports_a_body_with_no_translation_in_it() {
        for body in [
            r#"{ "content": [] }"#,
            r#"{ "content": [{ "type": "text", "text": "  " }] }"#,
            r#"{ "id": "msg_1" }"#,
            "not json",
        ] {
            assert!(
                matches!(
                    Claude.parse_response(body),
                    Err(TranslationError::MalformedResponse { .. })
                ),
                "body: {body}",
            );
        }
    }

    #[test]
    fn claude_surfaces_its_own_error_wording() {
        let body = r#"{ "type": "error", "error": { "type": "not_found_error", "message": "model: nope" } }"#;
        assert_eq!(Claude.error_message(body).as_deref(), Some("model: nope"));
        assert_eq!(Claude.error_message("{}"), None);
    }

    // --- OpenAI ---

    #[test]
    fn openai_needs_a_model_because_this_build_will_not_guess_one() {
        assert_eq!(
            Openai.build_request("k", &request()),
            Err(TranslationError::ModelRequired),
        );
    }

    #[test]
    fn openai_posts_to_chat_completions_with_a_bearer_key() {
        let http = Openai
            .build_request(
                "sk-openai-123",
                &TranslationRequest {
                    model: Some("gpt-4.1-mini".to_string()),
                    ..request()
                },
            )
            .unwrap();

        assert_eq!(http.url, "https://api.openai.com/v1/chat/completions");
        assert_eq!(header(&http, "authorization"), Some("Bearer sk-openai-123"),);
        let body = body_of(&http);
        assert_eq!(body["model"], "gpt-4.1-mini");
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][1]["role"], "user");
        // Rejected by some current models; the prompt bounds the reply instead.
        assert!(body.get("max_tokens").is_none());
        assert!(body.get("temperature").is_none());
    }

    #[test]
    fn openai_reads_the_translation_out_of_the_first_choice() {
        let body = r#"{
            "choices": [{ "finish_reason": "stop", "message": { "role": "assistant", "content": "必要なのは注意だけ。" } }]
        }"#;
        assert_eq!(Openai.parse_response(body).unwrap(), "必要なのは注意だけ。");
    }

    #[test]
    fn openai_reports_a_filtered_completion_as_a_refusal() {
        let body = r#"{ "choices": [{ "finish_reason": "content_filter", "message": { "content": "" } }] }"#;
        assert_eq!(Openai.parse_response(body), Err(TranslationError::Refused));
    }

    #[test]
    fn openai_reports_a_body_with_no_translation_in_it() {
        for body in [
            r#"{ "choices": [] }"#,
            r#"{ "choices": [{ "message": { "content": "" } }] }"#,
            r#"{ "object": "chat.completion" }"#,
        ] {
            assert!(
                matches!(
                    Openai.parse_response(body),
                    Err(TranslationError::MalformedResponse { .. })
                ),
                "body: {body}",
            );
        }
    }

    #[test]
    fn openai_surfaces_its_own_error_wording() {
        let body = r#"{ "error": { "message": "The model `nope` does not exist" } }"#;
        assert_eq!(
            Openai.error_message(body).as_deref(),
            Some("The model `nope` does not exist"),
        );
    }

    // --- DeepL ---

    #[test]
    fn deepl_picks_the_host_from_the_key_suffix() {
        let free = Deepl.build_request("abc:fx", &request()).unwrap();
        assert_eq!(free.url, "https://api-free.deepl.com/v2/translate");

        let paid = Deepl.build_request("abc", &request()).unwrap();
        assert_eq!(paid.url, "https://api.deepl.com/v2/translate");
    }

    #[test]
    fn deepl_sends_the_selection_the_language_code_and_its_context() {
        let http = Deepl.build_request("abc", &request()).unwrap();

        assert_eq!(header(&http, "authorization"), Some("DeepL-Auth-Key abc"),);
        let body = body_of(&http);
        assert_eq!(body["text"][0], "Attention is all you need.");
        assert_eq!(body["target_lang"], "JA");
        let context = body["context"].as_str().unwrap();
        assert!(context.contains("we propose the Transformer"));
        assert!(context.contains("Attention is all you need."));
        assert!(context.contains("trains faster"));
    }

    #[test]
    fn deepl_omits_the_context_field_when_there_is_none() {
        let http = Deepl
            .build_request(
                "abc",
                &TranslationRequest {
                    context_before: String::new(),
                    context_after: String::new(),
                    ..request()
                },
            )
            .unwrap();
        assert!(body_of(&http).get("context").is_none());
    }

    #[test]
    fn deepl_language_codes_use_the_variants_deepl_insists_on() {
        for (tag, expected) in [
            ("ja", "JA"),
            ("ja-JP", "JA"),
            ("de", "DE"),
            ("ko", "KO"),
            // EN and PT are refused without a variant.
            ("en", "EN-US"),
            ("en-GB", "EN-GB"),
            ("en-AU", "EN-US"),
            ("pt", "PT-BR"),
            ("pt-PT", "PT-PT"),
            ("zh", "ZH"),
            ("zh-TW", "ZH-HANT"),
            ("zh-Hans", "ZH-HANS"),
            ("fr_CA", "FR"),
        ] {
            assert_eq!(deepl_target_lang(tag), expected, "tag: {tag}");
        }
    }

    #[test]
    fn deepl_reads_the_translation_out_of_the_first_result() {
        let body = r#"{ "translations": [{ "detected_source_language": "EN", "text": "必要なのは注意だけ。" }] }"#;
        assert_eq!(Deepl.parse_response(body).unwrap(), "必要なのは注意だけ。");
    }

    #[test]
    fn deepl_reports_a_body_with_no_translation_in_it() {
        for body in [
            r#"{ "translations": [] }"#,
            r#"{ "message": "Bad request" }"#,
        ] {
            assert!(
                matches!(
                    Deepl.parse_response(body),
                    Err(TranslationError::MalformedResponse { .. })
                ),
                "body: {body}",
            );
        }
    }

    #[test]
    fn deepl_surfaces_its_own_error_wording() {
        let body = r#"{ "message": "Value for 'target_lang' not supported." }"#;
        assert_eq!(
            Deepl.error_message(body).as_deref(),
            Some("Value for 'target_lang' not supported."),
        );
    }

    // --- interpreting an HTTP outcome ---

    fn responded(status: u16, body: &str) -> Result<String> {
        interpret(
            &Claude,
            &HttpResponse {
                status,
                body: body.to_string(),
            },
        )
    }

    #[test]
    fn a_successful_response_yields_the_translation() {
        let body = r#"{ "content": [{ "type": "text", "text": "訳文" }] }"#;
        assert_eq!(responded(200, body).unwrap(), "訳文");
    }

    #[test]
    fn a_rejected_key_and_an_exhausted_quota_both_read_as_unauthorized() {
        for status in [401, 403, 456] {
            assert_eq!(
                responded(status, "{}"),
                Err(TranslationError::Unauthorized),
                "status: {status}",
            );
        }
    }

    #[test]
    fn rate_limits_and_outages_are_told_apart() {
        assert_eq!(responded(429, "{}"), Err(TranslationError::RateLimited));
        assert_eq!(
            responded(503, "{}"),
            Err(TranslationError::Unavailable { status: 503 }),
        );
    }

    #[test]
    fn another_failure_carries_the_providers_wording_when_it_gave_one() {
        let body = r#"{ "error": { "message": "model: nope" } }"#;
        assert_eq!(
            responded(404, body),
            Err(TranslationError::BadRequest {
                message: "model: nope".to_string()
            }),
        );
        assert_eq!(
            responded(418, "<html>"),
            Err(TranslationError::BadRequest {
                message: "HTTP 418".to_string()
            }),
        );
    }

    #[test]
    fn errors_serialize_with_a_kind_the_frontend_can_match_on() {
        let json = serde_json::to_value(TranslationError::Unavailable { status: 503 }).unwrap();
        assert_eq!(json["kind"], "unavailable");
        assert_eq!(json["status"], 503);

        let json = serde_json::to_value(TranslationError::MissingKey).unwrap();
        assert_eq!(json["kind"], "missingKey");

        let json = serde_json::to_value(TranslationError::TextTooLong { limit: 4000 }).unwrap();
        assert_eq!(json["kind"], "textTooLong");
        assert_eq!(json["limit"], 4000);
    }

    #[test]
    fn a_translation_serializes_for_the_panel_that_shows_it() {
        let json = serde_json::to_value(Translation {
            text: "訳文".to_string(),
            provider: "claude".to_string(),
            model: Some("claude-opus-5".to_string()),
            target_language: "ja".to_string(),
        })
        .unwrap();

        assert_eq!(json["text"], "訳文");
        assert_eq!(json["provider"], "claude");
        assert_eq!(json["model"], "claude-opus-5");
        assert_eq!(json["targetLanguage"], "ja");
    }

    #[test]
    fn every_provider_builds_a_request_for_a_model_that_is_set() {
        for id in settings::PROVIDERS {
            let provider = provider_for(id);
            let http = provider
                .build_request(
                    "key",
                    &TranslationRequest {
                        model: Some("some-model".to_string()),
                        ..request()
                    },
                )
                .unwrap_or_else(|err| panic!("{}: {err:?}", id.id()));
            assert!(http.url.starts_with("https://"), "{}", id.id());
            assert!(
                http.headers.iter().any(|(_, value)| value.contains("key")),
                "{} sends no key",
                id.id(),
            );
        }
    }
}
