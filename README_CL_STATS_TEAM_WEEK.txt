AliScore update: Champions League separate statistics + 8-player Team of the Week

Included:
- Existing AliScore app and current admin center preserved.
- New independent champions_league_player_stats PostgreSQL table.
- New champions_league_team_of_week PostgreSQL table.
- GET /api/champions-league/statistics
- Admin-only PUT /api/champions-league/statistics/:playerId
- Team of the Week is selected automatically from Champions League statistics (performance rating, goals, assists, saves, appearances and cards). A goalkeeper is prioritized when a player position identifies one.
- Champions League page now has a separate statistics table and an automatically selected 8-player lineup view. The admin no longer manually picks the lineup; editing Champions League stats recalculates the team automatically.
- Champions League stats do not change the normal AliScore player statistics.

Deployment:
Replace the project files with the files in this ZIP and deploy normally on Render. Database tables are created automatically by the existing schema initialization when the server starts. Admin login is required to edit stats or save the Champions League Team of the Week.

Validation performed: Node syntax checks passed for server.js and inline browser JavaScript. No live Render/database integration test was performed in this environment.


HƏFTƏNİN KOMANDASI: Köhnə “Xəyal komandası” bölməsi çıxarıldı və “Həftənin komandası” ilə əvəz edildi. Oyunlar bitənə qədər SOON görünür; ən son oynanılmış turun bütün matçları tamamlananda 8 oyunçu statistikaya əsasən avtomatik seçilir.
