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
  // =========================
  // TABLES
  // =========================

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

  // =========================
  // TEAMS
  // =========================

  const teams = [
    "Xirdalan United",
    "Xirdalan Wolves",
    "Neweli FK",
    "MSN FK",
    "Lotu pişiklər"
  ];

  for (const teamName of teams) {
    await pool.query(
      `
      INSERT INTO teams (name)
      VALUES ($1)
      ON CONFLICT (name) DO NOTHING
      `,
      [teamName]
    );
  }

  // =========================
  // PLAYERS — 20
  // =========================

  const players = [
    // Xirdalan Wolves — 4
    ["Ali", "Xirdalan Wolves"],
    ["Emin", "Xirdalan Wolves"],
    ["Huseyin", "Xirdalan Wolves"],
    ["Raul", "Xirdalan Wolves"],

    // Xirdalan United — 5
    ["Amil", "Xirdalan United"],
    ["Elmir", "Xirdalan United"],
    ["İsa", "Xirdalan United"],
    ["Ümüd", "Xirdalan United"],
    ["Huseyin", "Xirdalan United"],

    // MSN FK — 4
    ["Fuad", "MSN FK"],
    ["Murad", "MSN FK"],
    ["Ayxan", "MSN FK"],
    ["Şahin", "MSN FK"],

    // Neweli FK — 4
    ["Tofik", "Neweli FK"],
    ["Arda", "Neweli FK"],
    ["Veli", "Neweli FK"],
    ["Emil", "Neweli FK"],

    // Lotu pişiklər — 3
    ["Kamran", "Lotu pişiklər"],
    ["Ayxan", "Lotu pişiklər"],
    ["Ramil", "Lotu pişiklər"]
  ];

  for (const [playerName, teamName] of players) {
    const teamResult = await pool.query(
      `SELECT id FROM teams WHERE name = $1`,
      [teamName]
    );

    if (teamResult.rows.length === 0) {
      console.log(`Team not found: ${teamName}`);
      continue;
    }

    const teamId = teamResult.rows[0].id;

    const existingPlayer = await pool.query(
      `
      SELECT id
      FROM players
      WHERE name = $1
        AND team_id = $2
      `,
      [playerName, teamId]
    );

    if (existingPlayer.rows.length === 0) {
      await pool.query(
        `
        INSERT INTO players
        (name, team_id, number, position)
        VALUES ($1, $2, $3, $4)
        `,
        [
          playerName,
          teamId,
          0,
          "Yarımmüdafiəçi"
        ]
      );
    }
  }

  console.log("Database tables ready");
  console.log("Teams ready:", teams.length);
  console.log("Players ready:", players.length);
}

// =========================
// HEALTH
// =========================

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

// =========================
// TEAMS API
// =========================

app.get("/api/teams", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM teams
      ORDER BY
        points DESC,
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

app.post("/api/teams", async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        error: "Komanda adı tələb olunur"
      });
    }

    const result = await pool.query(
      `
      INSERT INTO teams (name)
      VALUES ($1)
      RETURNING *
      `,
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

// =========================
// PLAYERS API
// =========================

app.get("/api/players", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        players.*,
        teams.name AS team_name
      FROM players
      LEFT JOIN teams
        ON teams.id = players.team_id
      ORDER BY
        teams.name ASC,
        players.name ASC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("Players error:", error.message);

    res.status(500).json({
      error: "Oyunçuları yükləmək mümkün olmadı"
    });
  }
});

app.post("/api/players", async (req, res) => {
  try {
    const {
      name,
      team_id,
      number,
      position
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        error: "Oyunçu adı tələb olunur"
      });
    }

    const result = await pool.query(
      `
      INSERT INTO players
      (name, team_id, number, position)
      VALUES ($1, $2, $3, $4)
      RETURNING *
      `,
      [
        name.trim(),
        team_id || null,
        number || 0,
        position || "Yarımmüdafiəçi"
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Add player error:", error.message);

    res.status(500).json({
      error: "Oyunçu əlavə etmək mümkün olmadı"
    });
  }
});

// =========================
// HOME
// =========================
app.use(express.static("public"));

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});


// =========================
// START
// =========================

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`AliScore server running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error(
      "Database initialization failed:",
      error.message
    );

    process.exit(1);
  });
