# Optional features (all off by default)

Switched on under **Feature flags** in the console: `e_guides`, `astrology`, `voice_calls`. A switched-off feature answers exactly like a route that does not exist (404). The installable app (PWA) is static and has no flag.

## E-guides and audio (`e_guides`)

- Staff (`content.manage`) write guides in a small markdown subset (headings, lists, bold, italic, links) and attach one audio file each. Audio uploads go straight to the documents bucket through a signed URL limited to the declared type and size; the server checks the object exists before attaching it and removes the replaced file.
- **Free** guides are readable by anyone. **Premium** guides show their summary to everyone but the body and audio only to Premium and Concierge members (`402 PREMIUM_ONLY` for audio).
- Audio is never the only way in: the full text is the transcript. Audio links are signed and last an hour.
- Guides are parsed to data and rendered as React elements, so raw HTML in a guide can never run; links with `javascript:`, `data:` or protocol-relative URLs are shown as plain text.

## Voice calls (`voice_calls`)

Between two members of a **mutually accepted** introduction, only when **both** have switched on "I am open to a phone call" (either can withdraw at any time).

- The platform calls the requester first and bridges the other person; both see the platform's virtual number. **Phone numbers are never returned by the API or written to logs.** Calls are not recorded.
- Both phones must be verified, both accounts active, 9 am to 9 pm India time, at most 3 calls per day per introduction. Blocking ends the introduction and therefore the ability to call.
- Provider status callbacks (`POST /webhooks/calls`) are signature checked (HMAC of the raw body in `x-call-signature`), idempotent and cannot move a finished call backwards.
- Providers: `mock` (development) and Exotel's connect-two-numbers API. Production refuses the mock and the default webhook secret.
- Call records keep who started it, when, status and length, never a number; they are removed with the member's account.

## Astrology (`astrology`)

- Needs the member's `astrology` consent **and** a Premium or Concierge plan, checked on every request, so withdrawing consent or leaving the plan stops access immediately.
- Birth details are encrypted at rest (field encryption) and can be deleted at any time, which also deletes every reading that used them (including a match reading when either person erases).
- A **compatibility reading** is available only for an unlocked introduction when both people have consented, added details and ticked "allow a compatibility reading". It is cached once per introduction and shown to both.
- **Never used for matching.** Nothing in the matching engine, review queue or ranking imports astrology data; every response carries the disclaimer, and the UI says so.
- Provider adapter: `mock` returns clearly marked **sample** data (not astronomy) and `rest` talks to a licensed provider with a fixed JSON contract (`POST /chart`, `POST /match`) whose responses are validated before use. Production refuses the mock.

## Installable app (PWA)

`manifest.webmanifest` (standalone, theme colours) and a service worker that does two things only: web push, and a friendly **offline page** when a page load fails. It deliberately caches **no** API responses, introductions, messages or photos. Settings offers "Install" where the browser supports it and a short iPhone hint otherwise.
