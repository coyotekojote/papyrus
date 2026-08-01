import "@testing-library/jest-dom/vitest";

// jsdom implements neither of these, and the viewer depends on both. Layout is
// always zero-sized in jsdom, so the stubs simply report nothing observable.
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {};
}
if (!Element.prototype.scrollBy) {
  Element.prototype.scrollBy = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
