AliScore — updated version.
Keeps existing database/data and adds:
- light white + green UI and entrance animation
- players, standings, goals, assists, saves, own goals, MVP, cards
- transfer market with player value in AZN (₼)
- Goal of the Week
- admin-only Ali AI statistics assistant
- real Web Push service worker and test endpoint

Render Environment must contain DATABASE_URL, ADMIN_PASSWORD, JWT_SECRET,
VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_EMAIL.
Database migrations use IF NOT EXISTS / ALTER TABLE and do not reset existing data.
