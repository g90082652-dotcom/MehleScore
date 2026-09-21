const express = require("express");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teams (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      points INTEGER DEFAULT 0,
      played INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      draws INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      goals_for INTEGER DEFAULT 0,
      goals_against INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      number INTEGER DEFAULT 0,
      position TEXT DEFAULT 'Yarımmüdafiəçi',
      goals INTEGER DEFAULT 0,
      assists INTEGER DEFAULT 0,
      saves INTEGER DEFAULT 0,
      yellow_cards INTEGER DEFAULT 0,
      red_cards INTEGER DEFAULT 0,
      photo TEXT
    );

    CREATE TABLE IF NOT EXISTS matches (
      id SERIAL PRIMARY KEY,
      home_team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
      away_team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
      home_score INTEGER DEFAULT 0,
      away_score INTEGER DEFAULT 0,
      match_date TIMESTAMP,
      status TEXT DEFAULT 'scheduled'
    );
  `);
    const teams = [
      "Xirdalan United",
      "Xirdalan Wolves",
      "Neweli FK",
      "MSN FK",
      "Lotu pişiklər"
    ];

    for (const team of teams) {
      await pool.query(
        `INSERT INTO teams (name)
         VALUES ($1)
         ON CONFLICT (name) DO NOTHING`,
        [team]
      );
    }
  console.log("Database tables ready");
}

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT NOW()");

    res.json({
      ok: true,
      app: "AliScore",
      database: "connected"
    });
  } catch (error) {
    console.error("Health database error:", error.message);

    res.status(500).json({
      ok: false,
      app: "AliScore",
      database: "error"
    });
  }
});
// Получить все команды
app.get("/api/teams", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM teams
      ORDER BY points DESC,
               (goals_for - goals_against) DESC,
               goals_for DESC,
               name ASC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("Teams error:", error.message);
    res.status(500).json({
      error: "Komandaları yükləmək mümkün olmadı"
    });
  }
});

// Добавить команду
app.post("/api/teams", async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        error: "Komanda adı tələb olunur"
      });
    }

    const result = await pool.query(
      `INSERT INTO teams (name)
       VALUES ($1)
       RETURNING *`,
      [name.trim()]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Add team error:", error.message);
    res.status(500).json({
      error: "Komanda əlavə etmək mümkün olmadı"
    });
  }
});
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="az">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>AliScore</title>
      <style>
        body {
          margin: 0;
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          background: #07111f;
          color: white;
          font-family: Arial, sans-serif;
        }

        .box {
          text-align: center;
          padding: 30px;
        }

        h1 {
          font-size: 42px;
          margin-bottom: 10px;
        }

        p {
          color: #9fb0c5;
          font-size: 18px;
        }

        .ok {
          display: inline-block;
          margin-top: 20px;
          padding: 12px 20px;
          border-radius: 12px;
          background: #123b2a;
          color: #5cff9d;
        }
      </style>
    </head>

    <body>
      <div class="box">
        <h1>⚽ AliScore</h1>
        <p>PostgreSQL ilə yeni layihə</p>
        <div class="ok">SERVER ONLINE</div>
      </div>
    </body>
    </html>
  `);
});

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`AliScore server running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Database initialization failed:", error.message);
    process.exit(1);
  });
