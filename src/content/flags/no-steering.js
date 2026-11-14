// Injected before the other content scripts when hints for Chrome's language
// model are turned off in the settings. A file instead of a storage read keeps
// the decision synchronous: storage may answer only after Chrome has looked.
globalThis.__nuTranslateNoSteering = true;
