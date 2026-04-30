## v0.2.25

### Improvements
- Realtime speech channel is now more resilient: occasional server heartbeat decode errors no longer kill the session; persistent errors immediately stop recording with a clear "speech channel interrupted" toast — no more discovering an empty transcript after release.
- History page: added a manual refresh button to sync the local database.
- Top bar: credits / UNLIMITED indicator now has an icon for better visibility.

### Fixes
- Fixed an edge case where the recording state could get stuck after the STT worker died, requiring an app restart to recover.

### Other
- Promo landing page redesign: new Hero / Demo / CTA visuals, plus FAQ and Navigation/Footer sections.
