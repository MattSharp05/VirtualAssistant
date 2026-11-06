/* global require, module, process, console */
// electron-builder's mac signing hook (JD-88, ADR 0010). Without JARVIS_SIGN_IDENTITY it signs ad hoc,
// as before. With it (release.yml imports Matthew's self-signed "JARVIS Desk Signing" certificate from
// the MAC_SIGN_P12 secret into a temp keychain), every release is signed by the same certificate, so
// the app's designated requirement stays the same across updates and macOS keeps the microphone and
// camera permission. The certificate isn't trusted by Apple, so osx-sign's identity check is skipped.
// electron-builder loads this hook with require(), so it stays CommonJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { signAsync } = require(
  require.resolve("@electron/osx-sign", { paths: [require.resolve("app-builder-lib")] }),
);

module.exports = async function sign(opts) {
  const identity = process.env.JARVIS_SIGN_IDENTITY;
  const keychain = process.env.JARVIS_SIGN_KEYCHAIN;
  console.log(`  • signing ${opts.app} with ${identity ? `certificate ${identity}` : "an ad-hoc signature"}`);
  await signAsync({
    ...opts,
    identity: identity || "-",
    identityValidation: false,
    ...(identity && keychain ? { keychain } : {}),
  });
};
