const express = require("express");
const { Pool } = require("pg");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const path = require("path");

const app = express();

app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());

const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const JWT_SECRET = process.env.JWT_SECRET;

if (!DATABASE_URL || !ADMIN_PASSWORD || !JWT_SECRET) {
  console.error("Missing DATABASE_URL, ADMIN_PASSWORD or JWT_SECRET");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

/* =========================
   DATABASE
========================= */

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teams (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      points INTEGER DEFAULT 0,
      played INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      draws INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      goals_for INTEGER DEFAULT 0,
      goals_against INTEGER DEFAULT 0
    );
  `);

  await pool.query(`
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
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS matches (
      id SERIAL PRIMARY KEY,
      home_team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
      away_team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
      home_score INTEGER DEFAULT 0,
      away_score INTEGER DEFAULT 0,
      match_date TIMESTAMP DEFAULT NOW(),
      status TEXT DEFAULT 'scheduled'
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS match_events (
      id SERIAL PRIMARY KEY,
      match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      type TEXT NOT NULL,
      minute INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS team_of_week (
      id SERIAL PRIMARY KEY,
      week TEXT NOT NULL,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      position TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS lineups (
      id SERIAL PRIMARY KEY,
      match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      position TEXT NOT NULL,
      UNIQUE(match_id, player_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transfers (
      id SERIAL PRIMARY KEY,
      player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      from_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      to_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  /* =========================
     SEED TEAMS
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
     SEED PLAYERS
  ========================= */

  const seedPlayers = [
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

  for (const [playerName, teamName] of seedPlayers) {
    const team = await pool.query(
      `SELECT id FROM teams WHERE name = $1`,
      [teamName]
    );

    if (!team.rows.length) continue;

    const exists = await pool.query(
      `
      SELECT id
      FROM players
      WHERE name = $1
        AND team_id = $2
      LIMIT 1
      `,
      [playerName, team.rows[0].id]
    );

    if (!exists.rows.length) {
      await pool.query(
        `
        INSERT INTO players (name, team_id)
        VALUES ($1, $2)
        `,
        [playerName, team.rows[0].id]
      );
    }
  }

  console.log("Database initialized");
}

/* =========================
   ADMIN
========================= */

function adminRequired(req, res, next) {
  try {
    const token = req.cookies.aliscore_admin;

    if (!token) {
      return res.status(401).json({
        ok: false,
        error: "Admin login required"
      });
    }

    const decoded = jwt.verify(token, JWT_SECRET);

    if (!decoded || decoded.admin !== true) {
      return res.status(401).json({
        ok: false,
        error: "Unauthorized"
      });
    }

    next();
  } catch (err) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized"
    });
  }
}

/* =========================
   HEALTH
========================= */

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      ok: true,
      database: "connected"
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      ok: false,
      database: "error"
    });
  }
});

/* =========================
   ADMIN LOGIN
========================= */

app.post("/api/admin/login", (req, res) => {
  const { password } = req.body;

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({
      ok: false,
      error: "Wrong password"
    });
  }

  const token = jwt.sign(
    {
      admin: true
    },
    JWT_SECRET,
    {
      expiresIn: "7d"
    }
  );

  res.cookie("aliscore_admin", token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000
  });

  res.json({
    ok: true
  });
});

app.get("/api/admin/me", (req, res) => {
  try {
    const token = req.cookies.aliscore_admin;

    if (!token) {
      return res.json({
        ok: true,
        admin: false
      });
    }

    jwt.verify(token, JWT_SECRET);

    res.json({
      ok: true,
      admin: true
    });
  } catch {
    res.json({
      ok: true,
      admin: false
    });
  }
});

app.post("/api/admin/logout", (req, res) => {
  res.clearCookie("aliscore_admin", {
    httpOnly: true,
    secure: true,
    sameSite: "lax"
  });

  res.json({
    ok: true
  });
});

/* =========================
   TEAMS
========================= */

app.get("/api/teams", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        name,
        points,
        played,
        wins,
        draws,
        losses,
        goals_for AS gf,
        goals_against AS ga,
        (goals_for - goals_against) AS gd
      FROM teams
      ORDER BY points DESC,
               (goals_for - goals_against) DESC,
               goals_for DESC,
               name ASC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Failed to load teams"
    });
  }
});

app.post("/api/teams", adminRequired, async (req, res) => {
  try {
    const {
      name,
      points = 0,
      played = 0,
      wins = 0,
      draws = 0,
      losses = 0,
      gf = 0,
      ga = 0
    } = req.body;

    if (!name || !String(name).trim()) {
      return res.status(400).json({
        error: "Team name required"
      });
    }

    const result = await pool.query(
      `
      INSERT INTO teams
      (name, points, played, wins, draws, losses, goals_for, goals_against)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
      `,
      [
        String(name).trim(),
        Number(points) || 0,
        Number(played) || 0,
        Number(wins) || 0,
        Number(draws) || 0,
        Number(losses) || 0,
        Number(gf) || 0,
        Number(ga) || 0
      ]
    );

    res.json({
      ok: true,
      team: result.rows[0]
    });
  } catch (err) {
    console.error(err);

    if (err.code === "23505") {
      return res.status(400).json({
        error: "Team already exists"
      });
    }

    res.status(500).json({
      error: "Failed to create team"
    });
  }
});

async function updateTeam(req, res) {
  try {
    const id = Number(req.params.id);

    const {
      name,
      points,
      played,
      wins,
      draws,
      losses,
      gf,
      ga,
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
        name ?? null,
        points === undefined ? null : Number(points),
        played === undefined ? null : Number(played),
        wins === undefined ? null : Number(wins),
        draws === undefined ? null : Number(draws),
        losses === undefined ? null : Number(losses),
        gf !== undefined
          ? Number(gf)
          : goals_for !== undefined
          ? Number(goals_for)
          : null,
        ga !== undefined
          ? Number(ga)
          : goals_against !== undefined
          ? Number(goals_against)
          : null,
        id
      ]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Team not found"
      });
    }

    res.json({
      ok: true,
      team: result.rows[0]
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Failed to update team"
    });
  }
}

app.patch("/api/teams/:id", adminRequired, updateTeam);
app.put("/api/teams/:id", adminRequired, updateTeam);

app.delete("/api/teams/:id", adminRequired, async (req, res) => {
  try {
    const id = Number(req.params.id);

    const result = await pool.query(
      `DELETE FROM teams WHERE id = $1 RETURNING id`,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Team not found"
      });
    }

    res.json({
      ok: true
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Failed to delete team"
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
        p.id,
        p.name,
        p.team_id,
        t.name AS team_name,
        p.number,
        p.position,
        p.goals,
        p.assists,
        p.saves,
        p.yellow_cards,
        p.red_cards,
        p.photo
      FROM players p
      LEFT JOIN teams t ON t.id = p.team_id
      ORDER BY p.name ASC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Failed to load players"
    });
  }
});

app.post("/api/players", adminRequired, async (req, res) => {
  try {
    const {
      name,
      number = 0,
      position = "Yarımmüdafiəçi",
      team_id = null,
      photo = null
    } = req.body;

    if (!name || !String(name).trim()) {
      return res.status(400).json({
        error: "Player name required"
      });
    }

    const result = await pool.query(
      `
      INSERT INTO players
      (name, number, position, team_id, photo)
      VALUES ($1,$2,$3,$4,$5)
      RETURNING *
      `,
      [
        String(name).trim(),
        Number(number) || 0,
        position || "Yarımmüdafiəçi",
        team_id ? Number(team_id) : null,
        photo || null
      ]
    );

    res.json({
      ok: true,
      player: result.rows[0]
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Failed to create player"
    });
  }
});

async function updatePlayer(req, res) {
  try {
    const id = Number(req.params.id);

    const {
      name,
      number,
      position,
      team_id,
      photo
    } = req.body;

    const result = await pool.query(
      `
      UPDATE players
      SET
        name = COALESCE($1, name),
        number = COALESCE($2, number),
        position = COALESCE($3, position),
        team_id = $4,
        photo = COALESCE($5, photo)
      WHERE id = $6
      RETURNING *
      `,
      [
        name ?? null,
        number === undefined ? null : Number(number),
        position ?? null,
        team_id === undefined ? null : (team_id ? Number(team_id) : null),
        photo ?? null,
        id
      ]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Player not found"
      });
    }

    res.json({
      ok: true,
      player: result.rows[0]
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Failed to update player"
    });
  }
}

app.patch("/api/players/:id", adminRequired, updatePlayer);
app.put("/api/players/:id", adminRequired, updatePlayer);

app.delete("/api/players/:id", adminRequired, async (req, res) => {
  try {
    const id = Number(req.params.id);

    const result = await pool.query(
      `DELETE FROM players WHERE id = $1 RETURNING id`,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Player not found"
      });
    }

    res.json({
      ok: true
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Failed to delete player"
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
        m.id,
        m.home_team_id,
        m.away_team_id,
        home.name AS home_name,
        away.name AS away_name,
        home.name AS home_team_name,
        away.name AS away_team_name,
        m.home_score,
        m.away_score,
        m.match_date,
        m.status
      FROM matches m
      LEFT JOIN teams home ON home.id = m.home_team_id
      LEFT JOIN teams away ON away.id = m.away_team_id
      ORDER BY m.match_date DESC, m.id DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Failed to load matches"
    });
  }
});

app.post("/api/matches", adminRequired, async (req, res) => {
  try {
    const {
      home_team_id,
      away_team_id,
      match_date,
      status = "scheduled",
      home_score = 0,
      away_score = 0
    } = req.body;

    if (!home_team_id || !away_team_id) {
      return res.status(400).json({
        error: "Both teams are required"
      });
    }

    if (Number(home_team_id) === Number(away_team_id)) {
      return res.status(400).json({
        error: "Teams must be different"
      });
    }

    const result = await pool.query(
      `
      INSERT INTO matches
      (
        home_team_id,
        away_team_id,
        match_date,
        status,
        home_score,
        away_score
      )
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *
      `,
      [
        Number(home_team_id),
        Number(away_team_id),
        match_date || new Date(),
        status || "scheduled",
        Number(home_score) || 0,
        Number(away_score) || 0
      ]
    );

    res.json({
      ok: true,
      match: result.rows[0]
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Failed to create match"
    });
  }
});

async function updateMatch(req, res) {
  try {
    const id = Number(req.params.id);

    const {
      home_score,
      away_score,
      status,
      match_date
    } = req.body;

    const result = await pool.query(
      `
      UPDATE matches
      SET
        home_score = COALESCE($1, home_score),
        away_score = COALESCE($2, away_score),
        status = COALESCE($3, status),
        match_date = COALESCE($4, match_date)
      WHERE id = $5
      RETURNING *
      `,
      [
        home_score === undefined ? null : Number(home_score),
        away_score === undefined ? null : Number(away_score),
        status ?? null,
        match_date ?? null,
        id
      ]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Match not found"
      });
    }

    res.json({
      ok: true,
      match: result.rows[0]
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Failed to update match"
    });
  }
}

app.patch("/api/matches/:id", adminRequired, updateMatch);
app.put("/api/matches/:id", adminRequired, updateMatch);

app.delete("/api/matches/:id", adminRequired, async (req, res) => {
  try {
    const id = Number(req.params.id);

    const result = await pool.query(
      `DELETE FROM matches WHERE id = $1 RETURNING id`,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Match not found"
      });
    }

    res.json({
      ok: true
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Failed to delete match"
    });
  }
});

/* =========================
   MATCH EVENTS
========================= */

app.post(
  "/api/matches/:id/events",
  adminRequired,
  async (req, res) => {
    const client = await pool.connect();

    try {
      const matchId = Number(req.params.id);

      const {
        player_id,
        team_id,
        type,
        minute = 0
      } = req.body;

      const allowed = [
        "goal",
        "assist",
        "save",
        "yellow",
        "red"
      ];

      if (!allowed.includes(type)) {
        return res.status(400).json({
          error: "Invalid event type"
        });
      }

      await client.query("BEGIN");

      const match = await client.query(
        `SELECT * FROM matches WHERE id = $1`,
        [matchId]
      );

      if (!match.rows.length) {
        throw new Error("Match not found");
      }

      const player = player_id
        ? await client.query(
            `
            SELECT p.*, t.name AS team_name
            FROM players p
            LEFT JOIN teams t ON t.id = p.team_id
            WHERE p.id = $1
            `,
            [Number(player_id)]
          )
        : { rows: [] };

      const playerRow = player.rows[0];

      await client.query(
        `
        INSERT INTO match_events
        (match_id, player_id, team_id, type, minute)
        VALUES ($1,$2,$3,$4,$5)
        `,
        [
          matchId,
          player_id ? Number(player_id) : null,
          team_id ? Number(team_id) : null,
          type,
          Number(minute) || 0
        ]
      );

      if (playerRow) {
        if (type === "goal") {
          await client.query(
            `
            UPDATE players
            SET goals = goals + 1
            WHERE id = $1
            `,
            [playerRow.id]
          );
        }

        if (type === "assist") {
          await client.query(
            `
            UPDATE players
            SET assists = assists + 1
            WHERE id = $1
            `,
            [playerRow.id]
          );
        }

        if (type === "save") {
          await client.query(
            `
            UPDATE players
            SET saves = saves + 1
            WHERE id = $1
            `,
            [playerRow.id]
          );
        }

        if (type === "yellow") {
          await client.query(
            `
            UPDATE players
            SET yellow_cards = yellow_cards + 1
            WHERE id = $1
            `,
            [playerRow.id]
          );
        }

        if (type === "red") {
          await client.query(
            `
            UPDATE players
            SET red_cards = red_cards + 1
            WHERE id = $1
            `,
            [playerRow.id]
          );
        }
      }

      let notification = null;

      if (playerRow) {
        if (type === "goal") {
          notification = [
            "⚽ Qol",
            `${playerRow.name} qol vurdu!`
          ];
        }

        if (type === "yellow") {
          notification = [
            "🟨 Sarı kart",
            `${playerRow.name} sarı kart aldı.`
          ];
        }

        if (type === "red") {
          notification = [
            "🟥 Qırmızı kart",
            `${playerRow.name} qırmızı kart aldı.`
          ];
        }

        if (notification) {
          await client.query(
            `
            INSERT INTO notifications (title, message)
            VALUES ($1,$2)
            `,
            notification
          );
        }
      }

      await client.query("COMMIT");

      res.json({
        ok: true
      });
    } catch (err) {
      await client.query("ROLLBACK");

      console.error(err);

      res.status(500).json({
        error: err.message || "Failed to add event"
      });
    } finally {
      client.release();
    }
  }
);

/* =========================
   CARDS
========================= */

app.get("/api/cards", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        p.id,
        p.name,
        p.number,
        p.team_id,
        t.name AS team_name,
        p.yellow_cards,
        p.red_cards
      FROM players p
      LEFT JOIN teams t ON t.id = p.team_id
      ORDER BY p.red_cards DESC,
               p.yellow_cards DESC,
               p.name ASC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Failed to load cards"
    });
  }
});

app.post("/api/cards/change", adminRequired, async (req, res) => {
  try {
    const {
      player_id,
      type,
      amount
    } = req.body;

    const value = Number(amount);

    if (!player_id || !["yellow", "red"].includes(type)) {
      return res.status(400).json({
        error: "Invalid card data"
      });
    }

    if (!Number.isFinite(value) || value === 0) {
      return res.status(400).json({
        error: "Invalid amount"
      });
    }

    const column =
      type === "yellow"
        ? "yellow_cards"
        : "red_cards";

    const player = await pool.query(
      `
      SELECT
        p.id,
        p.name,
        p.${column} AS cards,
        t.name AS team_name
      FROM players p
      LEFT JOIN teams t ON t.id = p.team_id
      WHERE p.id = $1
      `,
      [Number(player_id)]
    );

    if (!player.rows.length) {
      return res.status(404).json({
        error: "Player not found"
      });
    }

    const oldValue = Number(player.rows[0].cards) || 0;
    const newValue = Math.max(0, oldValue + value);

    await pool.query(
      `
      UPDATE players
      SET ${column} = $1
      WHERE id = $2
      `,
      [newValue, Number(player_id)]
    );

    if (value > 0) {
      const title =
        type === "yellow"
          ? "🟨 Sarı kart"
          : "🟥 Qırmızı kart";

      const message =
        type === "yellow"
          ? `${player.rows[0].name} sarı kart aldı.`
          : `${player.rows[0].name} qırmızı kart aldı.`;

      await pool.query(
        `
        INSERT INTO notifications (title, message)
        VALUES ($1,$2)
        `,
        [title, message]
      );
    }

    res.json({
      ok: true,
      value: newValue
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Failed to change card"
    });
  }
});

/* =========================
   STATISTICS
========================= */

app.get("/api/statistics", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        p.id,
        p.name,
        t.name AS team_name,
        p.goals,
        p.assists,
        p.saves,
        p.yellow_cards,
        p.red_cards
      FROM players p
      LEFT JOIN teams t ON t.id = p.team_id
      ORDER BY p.goals DESC,
               p.assists DESC,
               p.saves DESC,
               p.name ASC
    `);

    res.json({
      players: result.rows,
      goals: result.rows
        .filter(p => Number(p.goals) > 0)
        .sort((a, b) => Number(b.goals) - Number(a.goals)),
      assists: result.rows
        .filter(p => Number(p.assists) > 0)
        .sort((a, b) => Number(b.assists) - Number(a.assists)),
      saves: result.rows
        .filter(p => Number(p.saves) > 0)
        .sort((a, b) => Number(b.saves) - Number(a.saves))
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Failed to load statistics"
    });
  }
});

/* =========================
   NOTIFICATIONS
========================= */

app.get("/api/notifications", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        title,
        message,
        created_at
      FROM notifications
      ORDER BY created_at DESC
      LIMIT 100
    `);

    res.json(result.rows);
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Failed to load notifications"
    });
  }
});

/* =========================
   TRANSFERS
========================= */

app.post("/api/transfers", adminRequired, async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      player_id,
      to_team_id
    } = req.body;

    if (!player_id || !to_team_id) {
      return res.status(400).json({
        error: "Player and destination team required"
      });
    }

    await client.query("BEGIN");

    const player = await client.query(
      `
      SELECT
        p.id,
        p.name,
        p.team_id,
        t.name AS old_team_name
      FROM players p
      LEFT JOIN teams t ON t.id = p.team_id
      WHERE p.id = $1
      `,
      [Number(player_id)]
    );

    if (!player.rows.length) {
      throw new Error("Player not found");
    }

    const newTeam = await client.query(
      `
      SELECT id, name
      FROM teams
      WHERE id = $1
      `,
      [Number(to_team_id)]
    );

    if (!newTeam.rows.length) {
      throw new Error("Destination team not found");
    }

    const oldTeamId = player.rows[0].team_id;
    const oldTeamName = player.rows[0].old_team_name;
    const newTeamName = newTeam.rows[0].name;

    if (oldTeamId === Number(to_team_id)) {
      throw new Error("Player is already in this team");
    }

    await client.query(
      `
      UPDATE players
      SET team_id = $1
      WHERE id = $2
      `,
      [
        Number(to_team_id),
        Number(player_id)
      ]
    );

    await client.query(
      `
      INSERT INTO transfers
      (player_id, from_team_id, to_team_id)
      VALUES ($1,$2,$3)
      `,
      [
        Number(player_id),
        oldTeamId,
        Number(to_team_id)
      ]
    );

    await client.query(
      `
      INSERT INTO notifications (title, message)
      VALUES ($1,$2)
      `,
      [
        "🔄 Transfer",
        `${player.rows[0].name} ${oldTeamName || "komandadan"} → ${newTeamName}`
      ]
    );

    await client.query("COMMIT");

    res.json({
      ok: true,
      message: `${player.rows[0].name} ${newTeamName} komandasına keçirildi.`
    });
  } catch (err) {
    await client.query("ROLLBACK");

    console.error(err);

    res.status(400).json({
      error: err.message || "Transfer failed"
    });
  } finally {
    client.release();
  }
});

/* =========================
   TEAM OF THE WEEK
========================= */

app.get("/api/team-of-week", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        tow.id,
        tow.week,
        tow.position,
        tow.created_at,
        p.id AS player_id,
        p.name,
        p.number,
        p.photo,
        p.team_id,
        t.name AS team_name,
        p.goals,
        p.assists,
        p.saves
      FROM team_of_week tow
      JOIN players p ON p.id = tow.player_id
      LEFT JOIN teams t ON t.id = p.team_id
      ORDER BY
        CASE tow.position
          WHEN 'Qapıçı' THEN 1
          WHEN 'Müdafiəçi' THEN 2
          WHEN 'Yarımmüdafiəçi' THEN 3
          WHEN 'Hücumçu' THEN 4
          ELSE 5
        END,
        tow.id ASC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Failed to load team of week"
    });
  }
});

app.post("/api/team-of-week", adminRequired, async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      week = "Bu həftə",
      players
    } = req.body;

    if (!Array.isArray(players)) {
      return res.status(400).json({
        error: "Players must be an array"
      });
    }

    if (players.length !== 11) {
      return res.status(400).json({
        error: "Team of the Week must contain exactly 11 players"
      });
    }

    const ids = players.map(p => Number(p.player_id));

    if (
      ids.some(id => !Number.isInteger(id)) ||
      new Set(ids).size !== 11
    ) {
      return res.status(400).json({
        error: "Players must be unique"
      });
    }

    const counts = {
      "Qapıçı": 0,
      "Müdafiəçi": 0,
      "Yarımmüdafiəçi": 0,
      "Hücumçu": 0
    };

    for (const item of players) {
      if (!counts.hasOwnProperty(item.position)) {
        return res.status(400).json({
          error: "Invalid position"
        });
      }

      counts[item.position]++;
    }

    if (
      counts["Qapıçı"] !== 1 ||
      counts["Müdafiəçi"] !== 4 ||
      counts["Yarımmüdafiəçi"] !== 3 ||
      counts["Hücumçu"] !== 3
    ) {
      return res.status(400).json({
        error:
          "Formation must be 1 goalkeeper, 4 defenders, 3 midfielders and 3 attackers"
      });
    }

    await client.query("BEGIN");

    const existingPlayers = await client.query(
      `
      SELECT id
      FROM players
      WHERE id = ANY($1::int[])
      `,
      [ids]
    );

    if (existingPlayers.rows.length !== 11) {
      throw new Error("One or more players were not found");
    }

    await client.query(
      `DELETE FROM team_of_week`
    );

    for (const item of players) {
      await client.query(
        `
        INSERT INTO team_of_week
        (week, player_id, position)
        VALUES ($1,$2,$3)
        `,
        [
          week,
          Number(item.player_id),
          item.position
        ]
      );
    }

    await client.query(
      `
      INSERT INTO notifications (title, message)
      VALUES ($1,$2)
      `,
      [
        "⭐ Komanda həftəsi",
        "Yeni Komanda həftəsi seçildi!"
      ]
    );

    await client.query("COMMIT");

    res.json({
      ok: true,
      message: "Team of the Week saved"
    });
  } catch (err) {
    await client.query("ROLLBACK");

    console.error(err);

    res.status(400).json({
      error: err.message || "Failed to save Team of the Week"
    });
  } finally {
    client.release();
  }
});

/* =========================
   LINEUPS
========================= */

app.get("/api/lineups/:matchId", async (req, res) => {
  try {
    const matchId = Number(req.params.matchId);

    const result = await pool.query(
      `
      SELECT
        l.id,
        l.match_id,
        l.player_id,
        l.position,
        p.name,
        p.number,
        p.photo,
        p.team_id,
        t.name AS team_name
      FROM lineups l
      JOIN players p ON p.id = l.player_id
      LEFT JOIN teams t ON t.id = p.team_id
      WHERE l.match_id = $1
      ORDER BY
        CASE l.position
          WHEN 'Qapıçı' THEN 1
          WHEN 'Müdafiəçi' THEN 2
          WHEN 'Yarımmüdafiəçi' THEN 3
          WHEN 'Hücumçu' THEN 4
          ELSE 5
        END,
        p.number ASC,
        p.name ASC
      `,
      [matchId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Failed to load lineup"
    });
  }
});

app.post("/api/lineups/:matchId", adminRequired, async (req, res) => {
  const client = await pool.connect();

  try {
    const matchId = Number(req.params.matchId);
    const { players } = req.body;

    if (!Array.isArray(players)) {
      return res.status(400).json({
        error: "Players must be an array"
      });
    }

    await client.query("BEGIN");

    await client.query(
      `DELETE FROM lineups WHERE match_id = $1`,
      [matchId]
    );

    for (const item of players) {
      if (!item.player_id || !item.position) continue;

      await client.query(
        `
        INSERT INTO lineups
        (match_id, player_id, position)
        VALUES ($1,$2,$3)
        ON CONFLICT (match_id, player_id)
        DO UPDATE SET position = EXCLUDED.position
        `,
        [
          matchId,
          Number(item.player_id),
          item.position
        ]
      );
    }

    await client.query("COMMIT");

    res.json({
      ok: true
    });
  } catch (err) {
    await client.query("ROLLBACK");

    console.error(err);

    res.status(500).json({
      error: "Failed to save lineup"
    });
  } finally {
    client.release();
  }
});

/* =========================
   STATIC FILES
========================= */

app.use(express.static(path.join(__dirname, "public")));

/* =========================
   SPA FALLBACK
========================= */

app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({
      error: "API route not found"
    });
  }

  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

/* =========================
   START
========================= */

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`AliScore running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error("Database initialization failed:");
    console.error(err);
    process.exit(1);
  });
