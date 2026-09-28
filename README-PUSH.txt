AliScore Push Notifications
===========================

1. On Render, open Environment Variables.
2. Keep/add:
   DATABASE_URL
   ADMIN_PASSWORD
   JWT_SECRET
   VAPID_PUBLIC_KEY
   VAPID_PRIVATE_KEY
   VAPID_EMAIL

3. VAPID_EMAIL can be your email, for example:
   aliscore@example.com

4. If VAPID keys are not already configured, use a matching P-256 VAPID public/private pair.
   Do not change the private key after users have subscribed unless you want them to subscribe again.

5. Deploy the project.

6. On iPhone:
   Safari -> AliScore -> Share -> Add to Home Screen.
   Open AliScore from the Home Screen.
   On the home page press "🔔 Bildirişləri aktiv et" and allow notifications.

The project now includes:
- /api/goal-of-week and all admin/voting routes
- real Web Push subscription endpoints
- service-worker.js
- PWA manifest and icons
- push notifications for goals, assists, saves, yellow/red cards, transfers, new Goal of the Week polls and Goal of the Week winner
- automatic removal of expired push subscriptions
