# Vendored browser bundles

`twilio-voice-sdk.min.js` is `@twilio/voice-sdk`'s self-contained browser
bundle (`dist/twilio.min.js`), copied verbatim from the installed package.
It is vendored because the package's exports map only exposes the ESM
build, which imports Node's `events` and cannot bundle for the browser
here. When upgrading `@twilio/voice-sdk` in package.json, re-copy:

    cp node_modules/@twilio/voice-sdk/dist/twilio.min.js src/vendor/twilio-voice-sdk.min.js

The IIFE attaches `Twilio` (with `Twilio.Device`) to `window`.
