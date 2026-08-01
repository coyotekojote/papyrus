import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("App", () => {
  it("renders the Papyrus heading", () => {
    render(<App />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Papyrus" }),
    ).toBeInTheDocument();
  });

  it("renders the tagline describing the app", () => {
    render(<App />);

    expect(
      screen.getByText("PDF viewer, built with Tauri + React."),
    ).toBeInTheDocument();
  });
});
