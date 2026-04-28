# Weedless Scheduler

Weedless Scheduler is a scheduling PWA for Weedless Lawn Care & Irrigation.

## Run locally

From this folder:

```powershell
.\start.ps1
```

Then open:

`http://127.0.0.1:4173`

## Live sync setup

The app now supports two data modes:

- Local-only mode with browser `localStorage`
- Live cloud sync with Supabase

To turn on cloud sync:

1. Create a Supabase project
2. Run the SQL in `supabase-setup.sql`
3. Copy `app-config.example.js` values into `app-config.js`
4. Fill in your Supabase project URL and public anon key
5. Reload the app

When cloud sync is connected, the header will show `Cloud sync live`.

## Security note

The current Supabase setup is designed for a fast MVP and shared no-login access. That means anyone with the app URL and browser config can reach the shared schedule data. If you want real access control later, add authentication and tighten the Supabase policies.

## Twilio SMS setup

Copy `.env.example` to `.env` and fill in:

```text
PORT=4173
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_FROM_NUMBER=+1yourtwilionumber
```

If those values are present, the app sends SMS automatically through Twilio.

If they are missing, the app falls back to copy-to-clipboard mode.

## Notes

- Browser `localStorage` is still used as an offline/local cache
- Shared real-time sync uses one Supabase row containing the app state JSON
- SMS sending happens through the local Node server so Twilio secrets do not sit in browser code
