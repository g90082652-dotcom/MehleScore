AliScore AI setup

1. Deploy this project to Render as usual.
2. In Render -> Environment add:
   OPENAI_API_KEY = your OpenAI API key
3. Optional:
   OPENAI_MODEL = gpt-5.6-luna
4. Keep existing variables:
   DATABASE_URL
   ADMIN_PASSWORD
   JWT_SECRET
   VAPID_PUBLIC_KEY
   VAPID_PRIVATE_KEY
   VAPID_EMAIL

AliScore AI is admin-only. It uses the existing admin JWT/cookie.
The AI can analyze AliScore data and propose player-stat changes.
Changes require admin confirmation in the AliScore AI page.

Rating rules:
Goal +3
Assist +2
Save +1
Own goal -3
Yellow card -2
Red card -4

The AI never receives the OpenAI API key in the browser. The server calls the OpenAI Responses API.
