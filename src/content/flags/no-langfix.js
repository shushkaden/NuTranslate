// Injected before the other content scripts when the language fix is turned
// off in the settings. A file instead of a storage read keeps the decision
// synchronous: storage may answer only after Chrome has looked at the page.
globalThis.__nuTranslateNoLangFix = true;
