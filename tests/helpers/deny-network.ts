// Explicit test-process preload: authentication errors must not depend on the
// live skills repository remaining private, or on the caller's GitHub token.
delete process.env.DITTOSH_SKILLS_TARBALL;
globalThis.fetch = async (input) => {
  const url = new URL(input instanceof Request ? input.url : input);
  return new Response("{}", { status: url.hostname === "registry.npmjs.org" ? 404 : 401 });
};

export {};
