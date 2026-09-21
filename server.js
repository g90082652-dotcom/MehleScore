const express = require("express");
const { Pool } = require("pg");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());

/* =========================
   ENVIRONMENT
========================= */

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing");
  process.exit(1);
}

if (!process.env.ADMIN_PASSWORD) {
  console.error("ADMIN_PASSWORD is missing");
  process.exit(1);
}

if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET is missing");
  process.exit(1);
}

/* =========================
   DATABASE
========================= */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

/* =========================
   DATABASE INIT
========================= */

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

  /* =========================
     TEAMS
  ========================= */

  const teams = [
    "Xirdalan United",
    "Xirdalan Wolves",
    "Neweli FK",
    "MSN FK",
    "Lotu pişiklər"
  ];

  for (const name of teams) {
    await pool.query(
      `
      INSERT INTO teams (name)
      VALUES ($1)
      ON CONFLICT (name) DO NOTHING
      `,
      [name]
    );
  }

  /* =========================
     PLAYERS
  ========================= */

  const players = [
    ["Ali", "Xirdalan Wolves"],
    ["Emin", "Xirdalan Wolves"],
    ["Huseyin", "Xirdalan Wolves"],
    ["Raul", "Xirdalan Wolves"],

    ["Amil", "Xirdalan United"],
    ["Elmir", "Xirdalan United"],
    ["İsa", "Xirdalan United"],
    ["Ümüd", "Xirdalan United"],
    ["Huseyin", "Xirdalan United"],

    ["Fuad", "MSN FK"],
    ["Murad", "MSN FK"],
    ["Ayxan", "MSN FK"],
    ["Şahin", "MSN FK"],

    ["Tofik", "Neweli FK"],
    ["Arda", "Neweli FK"],
    ["Veli", "Neweli FK"],
    ["Emil", "Neweli FK"],

    ["Kamran", "Lotu pişiklər"],
    ["Ayxan", "Lotu pişiklər"],
    ["Ramil", "Lotu pişiklər"]
  ];

  for (const [playerName, teamName] of players) {

    const team = await pool.query(
      `SELECT id FROM teams WHERE name = $1`,
      [teamName]
    );

    if (!team.rows.length) continue;

    const teamId = team.rows[0].id;

    const existing = await pool.query(
      `
      SELECT id
      FROM players
      WHERE name = $1
      AND team_id = $2
      `,
      [playerName, teamId]
    );

    if (!existing.rows.length) {

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

/* =========================
   AUTH HELPERS
========================= */

function createAdminToken() {

  return jwt.sign(
    {
      role: "admin"
    },
    process.env.JWT_SECRET,
    {
      expiresIn: "7d"
    }
  );
}


function requireAdmin(req, res, next) {

  try {

    const token = req.cookies.aliscore_admin;

    if (!token) {
      return res.status(401).json({
        error: "Admin girişi tələb olunur"
      });
    }

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    if (decoded.role !== "admin") {
      return res.status(403).json({
        error: "İcazə yoxdur"
      });
    }

    req.admin = decoded;

    next();

  } catch (error) {

    return res.status(401).json({
      error: "Admin sessiyası etibarsızdır"
    });
  }
}

/* =========================
   ADMIN LOGIN
========================= */

app.post("/api/admin/login", (req, res) => {

  const { password } = req.body;

  if (!password) {
    return res.status(400).json({
      error: "Şifrə daxil edin"
    });
  }

  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({
      error: "Şifrə yanlışdır"
    });
  }

  const token = createAdminToken();

  res.cookie(
    "aliscore_admin",
    token,
    {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000
    }
  );

  res.json({
    ok: true,
    message: "Admin giriş uğurludur"
  });
});


app.get("/api/admin/me", (req, res) => {

  try {

    const token = req.cookies.aliscore_admin;

    if (!token) {
      return res.json({
        loggedIn: false
      });
    }

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    res.json({
      loggedIn: true,
      role: decoded.role
    });

  } catch (error) {

    res.json({
      loggedIn: false
    });
  }
});


app.post("/api/admin/logout", (req, res) => {

  res.clearCookie("aliscore_admin");

  res.json({
    ok: true
  });
});

/* =========================
   HEALTH
========================= */

app.get("/api/health", async (req, res) => {

  try {

    await pool.query("SELECT NOW()");

    res.json({
      ok: true,
      app: "AliScore",
      database: "connected"
    });

  } catch (error) {

    console.error(
      "Health error:",
      error.message
    );

    res.status(500).json({
      ok: false,
      app: "AliScore",
      database: "error"
    });
  }
});

/* =========================
   TEAMS
========================= */

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

    console.error(
      "Teams error:",
      error.message
    );

    res.status(500).json({
      error: "Komandaları yükləmək mümkün olmadı"
    });
  }
});


app.post("/api/teams", requireAdmin, async (req, res) => {

  try {

    const {
      name,
      points = 0,
      played = 0,
      wins = 0,
      draws = 0,
      losses = 0,
      goals_for = 0,
      goals_against = 0
    } = req.body;

    if (!name || !name.trim()) {

      return res.status(400).json({
        error: "Komanda adı tələb olunur"
      });
    }

    const result = await pool.query(
      `
      INSERT INTO teams
      (
        name,
        points,
        played,
        wins,
        draws,
        losses,
        goals_for,
        goals_against
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
      `,
      [
        name.trim(),
        points,
        played,
        wins,
        draws,
        losses,
        goals_for,
        goals_against
      ]
    );

    res.status(201).json(
      result.rows[0]
    );

  } catch (error) {

    console.error(
      "Add team error:",
      error.message
    );

    res.status(500).json({
      error: "Komanda əlavə etmək mümkün olmadı"
    });
  }
});


app.patch("/api/teams/:id", requireAdmin, async (req, res) => {

  try {

    const { id } = req.params;

    const {
      name,
      points,
      played,
      wins,
      draws,
      losses,
      goals_for,
      goals_against
    } = req.body;

    const result = await pool.query(
      `
      UPDATE teams
      SET
        name = COALESCE($1, name),
        points = COALESCE($2, points),
        played = COALESCE($3, played),
        wins = COALESCE($4, wins),
        draws = COALESCE($5, draws),
        losses = COALESCE($6, losses),
        goals_for = COALESCE($7, goals_for),
        goals_against = COALESCE($8, goals_against)
      WHERE id = $9
      RETURNING *
      `,
      [
        name,
        points,
        played,
        wins,
        draws,
        losses,
        goals_for,
        goals_against,
        id
      ]
    );

    if (!result.rows.length) {

      return res.status(404).json({
        error: "Komanda tapılmadı"
      });
    }

    res.json(result.rows[0]);

  } catch (error) {

    console.error(
      "Update team error:",
      error.message
    );

    res.status(500).json({
      error: "Komandanı dəyişmək mümkün olmadı"
    });
  }
});

/* =========================
   PLAYERS
========================= */

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

    console.error(
      "Players error:",
      error.message
    );

    res.status(500).json({
      error: "Oyunçuları yükləmək mümkün olmadı"
    });
  }
});


app.post("/api/players", requireAdmin, async (req, res) => {

  try {

    const {
      name,
      team_id,
      number = 0,
      position = "Yarımmüdafiəçi"
    } = req.body;

    if (!name || !name.trim()) {

      return res.status(400).json({
        error: "Oyunçu adı tələb olunur"
      });
    }

    const result = await pool.query(
      `
      INSERT INTO players
      (
        name,
        team_id,
        number,
        position
      )
      VALUES ($1,$2,$3,$4)
      RETURNING *
      `,
      [
        name.trim(),
        team_id || null,
        number,
        position
      ]
    );

    res.status(201).json(
      result.rows[0]
    );

  } catch (error) {

    console.error(
      "Add player error:",
      error.message
    );

    res.status(500).json({
      error: "Oyunçu əlavə etmək mümkün olmadı"
    });
  }
});


app.patch("/api/players/:id", requireAdmin, async (req, res) => {

  try {

    const { id } = req.params;

    const {
      name,
      team_id,
      number,
      position,
      goals,
      assists,
      saves,
      yellow_cards,
      red_cards,
      photo
    } = req.body;

    const result = await pool.query(
      `
      UPDATE players
      SET
        name = COALESCE($1,name),
        team_id = COALESCE($2,team_id),
        number = COALESCE($3,number),
        position = COALESCE($4,position),
        goals = COALESCE($5,goals),
        assists = COALESCE($6,assists),
        saves = COALESCE($7,saves),
        yellow_cards = COALESCE($8,yellow_cards),
        red_cards = COALESCE($9,red_cards),
        photo = COALESCE($10,photo)
      WHERE id = $11
      RETURNING *
      `,
      [
        name,
        team_id,
        number,
        position,
        goals,
        assists,
        saves,
        yellow_cards,
        red_cards,
        photo,
        id
      ]
    );

    if (!result.rows.length) {

      return res.status(404).json({
        error: "Oyunçu tapılmadı"
      });
    }

    res.json(result.rows[0]);

  } catch (error) {

    console.error(
      "Update player error:",
      error.message
    );

    res.status(500).json({
      error: "Oyunçunu dəyişmək mümkün olmadı"
    });
  }
});

/* =========================
   MATCHES
========================= */

app.get("/api/matches", async (req, res) => {

  try {

    const result = await pool.query(`
      SELECT
        matches.id,
        matches.home_team_id,
        matches.away_team_id,
        matches.home_score,
        matches.away_score,
        matches.match_date,
        matches.status,
        home.name AS home_team_name,
        away.name AS away_team_name
      FROM matches
      LEFT JOIN teams home
        ON home.id = matches.home_team_id
      LEFT JOIN teams away
        ON away.id = matches.away_team_id
      ORDER BY
        matches.match_date ASC NULLS LAST,
        matches.id ASC
    `);

    res.json(result.rows);

  } catch (error) {

    console.error(
      "Matches error:",
      error.message
    );

    res.status(500).json({
      error: "Matçları yükləmək mümkün olmadı"
    });
  }
});


app.post("/api/matches", requireAdmin, async (req, res) => {

  try {

    const {
      home_team_id,
      away_team_id,
      home_score = 0,
      away_score = 0,
      match_date,
      status = "scheduled"
    } = req.body;

    if (!home_team_id || !away_team_id) {

      return res.status(400).json({
        error: "İki komanda seçilməlidir"
      });
    }

    if (
      String(home_team_id) ===
      String(away_team_id)
    ) {

      return res.status(400).json({
        error: "Eyni komanda özü ilə oynaya bilməz"
      });
    }

    const result = await pool.query(
      `
      INSERT INTO matches
      (
        home_team_id,
        away_team_id,
        home_score,
        away_score,
        match_date,
        status
      )
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *
      `,
      [
        home_team_id,
        away_team_id,
        home_score,
        away_score,
        match_date || null,
        status
      ]
    );

    res.status(201).json(
      result.rows[0]
    );

  } catch (error) {

    console.error(
      "Add match error:",
      error.message
    );

    res.status(500).json({
      error: "Matç əlavə etmək mümkün olmadı"
    });
  }
});


app.patch("/api/matches/:id", requireAdmin, async (req, res) => {

  try {

    const { id } = req.params;

    const {
      home_score,
      away_score,
      match_date,
      status
    } = req.body;

    const result = await pool.query(
      `
      UPDATE matches
      SET
        home_score = COALESCE($1,home_score),
        away_score = COALESCE($2,away_score),
        match_date = COALESCE($3,match_date),
        status = COALESCE($4,status)
      WHERE id = $5
      RETURNING *
      `,
      [
        home_score,
        away_score,
        match_date,
        status,
        id
      ]
    );

    if (!result.rows.length) {

      return res.status(404).json({
        error: "Matç tapılmadı"
      });
    }

    res.json(result.rows[0]);

  } catch (error) {

    console.error(
      "Update match error:",
      error.message
    );

    res.status(500).json({
      error: "Matçı dəyişmək mümkün olmadı"
    });
  }
});


app.delete("/api/matches/:id", requireAdmin, async (req, res) => {

  try {

    const { id } = req.params;

    const result = await pool.query(
      `
      DELETE FROM matches
      WHERE id = $1
      RETURNING id
      `,
      [id]
    );

    if (!result.rows.length) {

      return res.status(404).json({
        error: "Matç tapılmadı"
      });
    }

    res.json({
      ok: true
    });

  } catch (error) {

    console.error(
      "Delete match error:",
      error.message
    );

    res.status(500).json({
      error: "Matçı silmək mümkün olmadı"
    });
  }
});

/* =========================
   STATIC WEBSITE
========================= */

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

app.get("/", (req, res) => {

  res.sendFile(
    path.join(
      __dirname,
      "public",
      "index.html"
    )
  );
});

/* =========================
   START SERVER
========================= */

initDatabase()
  .then(() => {

    app.listen(PORT, () => {

      console.log(
        `AliScore server running on port ${PORT}`
      );

    });

  })
  .catch((error) => {

    console.error(
      "Database initialization failed:",
      error.message
    );

    process.exit(1);
  });
