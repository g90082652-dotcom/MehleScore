const express = require("express");
const { Pool } = require("pg");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: "15mb" }));
app.use(cookieParser());

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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* =========================
   DATABASE
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

    CREATE TABLE IF NOT EXISTS lineups (
      id SERIAL PRIMARY KEY,
      match_id INTEGER REFERENCES matches(id) ON DELETE CASCADE,
      player_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
      position TEXT NOT NULL,
      UNIQUE(match_id, player_id)
    );

    CREATE TABLE IF NOT EXISTS team_of_week (
      id SERIAL PRIMARY KEY,
      week TEXT NOT NULL,
      player_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
      position TEXT NOT NULL,
      UNIQUE(week, player_id)
    );

    CREATE TABLE IF NOT EXISTS transfers (
      id SERIAL PRIMARY KEY,
      player_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
      from_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      to_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      match_id INTEGER REFERENCES matches(id) ON DELETE CASCADE,
      player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      type TEXT NOT NULL,
      minute INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  /* Mövcud köhnə bazalar üçün sütunları da yoxlayırıq */
  await pool.query(`
    ALTER TABLE teams
      ADD COLUMN IF NOT EXISTS points INTEGER DEFAULT 0;

    ALTER TABLE teams
      ADD COLUMN IF NOT EXISTS played INTEGER DEFAULT 0;

    ALTER TABLE teams
      ADD COLUMN IF NOT EXISTS wins INTEGER DEFAULT 0;

    ALTER TABLE teams
      ADD COLUMN IF NOT EXISTS draws INTEGER DEFAULT 0;

    ALTER TABLE teams
      ADD COLUMN IF NOT EXISTS losses INTEGER DEFAULT 0;

    ALTER TABLE teams
      ADD COLUMN IF NOT EXISTS goals_for INTEGER DEFAULT 0;

    ALTER TABLE teams
      ADD COLUMN IF NOT EXISTS goals_against INTEGER DEFAULT 0;
  `);

  await pool.query(`
    ALTER TABLE players
      ADD COLUMN IF NOT EXISTS number INTEGER DEFAULT 0;

    ALTER TABLE players
      ADD COLUMN IF NOT EXISTS position TEXT DEFAULT 'Yarımmüdafiəçi';

    ALTER TABLE players
      ADD COLUMN IF NOT EXISTS goals INTEGER DEFAULT 0;

    ALTER TABLE players
      ADD COLUMN IF NOT EXISTS assists INTEGER DEFAULT 0;

    ALTER TABLE players
      ADD COLUMN IF NOT EXISTS saves INTEGER DEFAULT 0;

    ALTER TABLE players
      ADD COLUMN IF NOT EXISTS yellow_cards INTEGER DEFAULT 0;

    ALTER TABLE players
      ADD COLUMN IF NOT EXISTS red_cards INTEGER DEFAULT 0;

    ALTER TABLE players
      ADD COLUMN IF NOT EXISTS photo TEXT;
  `);

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

    await pool.query(
      `
      INSERT INTO players
      (name, team_id, number, position)
      SELECT $1,$2,0,'Yarımmüdafiəçi'
      WHERE NOT EXISTS (
        SELECT 1
        FROM players
        WHERE name = $1 AND team_id = $2
      )
      `,
      [playerName, teamId]
    );
  }

  console.log("Database ready");
}

/* =========================
   ADMIN
========================= */

function createAdminToken() {
  return jwt.sign(
    { role: "admin" },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
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

    next();
  } catch (error) {
    return res.status(401).json({
      error: "Admin sessiyası etibarsızdır"
    });
  }
}

app.post("/api/admin/login", (req, res) => {
  const password = String(req.body?.password || "");

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

  res.cookie("aliscore_admin", token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/"
  });

  res.json({
    ok: true,
    message: "Admin giriş uğurludur"
  });
});

app.get("/api/admin/me", (req, res) => {
  try {
    const token = req.cookies.aliscore_admin;

    if (!token) {
      return res.json({ loggedIn: false });
    }

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    res.json({
      loggedIn: true,
      role: decoded.role
    });
  } catch {
    res.json({
      loggedIn: false
    });
  }
});

app.post("/api/admin/logout", (req, res) => {
  res.clearCookie("aliscore_admin", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/"
  });

  res.json({ ok: true });
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
    console.error(error);

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
      SELECT *,
        (goals_for - goals_against) AS goal_difference
      FROM teams
      ORDER BY
        points DESC,
        goal_difference DESC,
        goals_for DESC,
        name ASC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Komandaları yükləmək mümkün olmadı"
    });
  }
});

app.post("/api/teams", requireAdmin, async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();

    if (!name) {
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
      [name]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Komanda əlavə etmək mümkün olmadı"
    });
  }
});

app.patch("/api/teams/:id", requireAdmin, async (req, res) => {
  try {
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
        name = COALESCE($1,name),
        points = COALESCE($2,points),
        played = COALESCE($3,played),
        wins = COALESCE($4,wins),
        draws = COALESCE($5,draws),
        losses = COALESCE($6,losses),
        goals_for = COALESCE($7,goals_for),
        goals_against = COALESCE($8,goals_against)
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
        req.params.id
      ]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Komanda tapılmadı"
      });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Komandanı dəyişmək mümkün olmadı"
    });
  }
});

app.delete("/api/teams/:id", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `
      DELETE FROM teams
      WHERE id = $1
      RETURNING id
      `,
      [req.params.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Komanda tapılmadı"
      });
    }

    res.json({ ok: true });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Komandanı silmək mümkün olmadı"
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
    console.error(error);

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
      position = "Yarımmüdafiəçi",
      photo = null
    } = req.body;

    if (!String(name || "").trim()) {
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
        position,
        photo
      )
      VALUES ($1,$2,$3,$4,$5)
      RETURNING *
      `,
      [
        String(name).trim(),
        team_id || null,
        Number(number) || 0,
        position,
        photo
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Oyunçu əlavə etmək mümkün olmadı"
    });
  }
});

app.patch("/api/players/:id", requireAdmin, async (req, res) => {
  try {
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
        req.params.id
      ]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Oyunçu tapılmadı"
      });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Oyunçunu dəyişmək mümkün olmadı"
    });
  }
});

app.delete("/api/players/:id", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `
      DELETE FROM players
      WHERE id = $1
      RETURNING id
      `,
      [req.params.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Oyunçu tapılmadı"
      });
    }

    res.json({ ok: true });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Oyunçunu silmək mümkün olmadı"
    });
  }
});

/* =========================
   PLAYER STATS
========================= */

app.post("/api/players/:id/stat", requireAdmin, async (req, res) => {
  try {
    const {
      type,
      amount = 1
    } = req.body;

    const allowed = [
      "goals",
      "assists",
      "saves",
      "yellow_cards",
      "red_cards"
    ];

    if (!allowed.includes(type)) {
      return res.status(400).json({
        error: "Yanlış statistika növü"
      });
    }

    const value = Math.max(
      0,
      Number(amount) || 0
    );

    const result = await pool.query(
      `
      UPDATE players
      SET ${type} = GREATEST(0, ${type} + $1)
      WHERE id = $2
      RETURNING *
      `,
      [value, req.params.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Oyunçu tapılmadı"
      });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Statistika dəyişmək mümkün olmadı"
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
        matches.*,
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
    console.error(error);

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
        Number(home_score) || 0,
        Number(away_score) || 0,
        match_date || null,
        status
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Matç əlavə etmək mümkün olmadı"
    });
  }
});

app.patch("/api/matches/:id", requireAdmin, async (req, res) => {
  try {
    const {
      home_team_id,
      away_team_id,
      home_score,
      away_score,
      match_date,
      status
    } = req.body;

    const result = await pool.query(
      `
      UPDATE matches
      SET
        home_team_id = COALESCE($1,home_team_id),
        away_team_id = COALESCE($2,away_team_id),
        home_score = COALESCE($3,home_score),
        away_score = COALESCE($4,away_score),
        match_date = COALESCE($5,match_date),
        status = COALESCE($6,status)
      WHERE id = $7
      RETURNING *
      `,
      [
        home_team_id,
        away_team_id,
        home_score,
        away_score,
        match_date,
        status,
        req.params.id
      ]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Matç tapılmadı"
      });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Matçı dəyişmək mümkün olmadı"
    });
  }
});

app.delete("/api/matches/:id", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `
      DELETE FROM matches
      WHERE id = $1
      RETURNING id
      `,
      [req.params.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Matç tapılmadı"
      });
    }

    res.json({ ok: true });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Matçı silmək mümkün olmadı"
    });
  }
});

/* =========================
   LINEUPS / HEYƏTLƏR
========================= */

app.get("/api/lineups/:matchId", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        lineups.*,
        players.name,
        players.number,
        players.photo,
        players.team_id
      FROM lineups
      JOIN players
        ON players.id = lineups.player_id
      WHERE lineups.match_id = $1
      ORDER BY
        CASE lineups.position
          WHEN 'Qapıçı' THEN 1
          WHEN 'Müdafiəçi' THEN 2
          WHEN 'Müdafiə' THEN 2
          WHEN 'Yarımmüdafiəçi' THEN 3
          WHEN 'Yarımmüdafiə' THEN 3
          WHEN 'Hücumçu' THEN 4
          WHEN 'Hücum' THEN 4
          ELSE 5
        END,
        players.name
      `,
      [req.params.matchId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Heyəti yükləmək mümkün olmadı"
    });
  }
});

app.post("/api/lineups", requireAdmin, async (req, res) => {
  try {
    const {
      match_id,
      player_id,
      position
    } = req.body;

    if (!match_id || !player_id || !position) {
      return res.status(400).json({
        error: "Matç, oyunçu və mövqe seçilməlidir"
      });
    }

    const result = await pool.query(
      `
      INSERT INTO lineups
      (match_id,player_id,position)
      VALUES ($1,$2,$3)
      ON CONFLICT (match_id,player_id)
      DO UPDATE SET position = EXCLUDED.position
      RETURNING *
      `,
      [match_id, player_id, position]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Heyətə oyunçu əlavə etmək mümkün olmadı"
    });
  }
});

app.delete(
  "/api/lineups/:matchId/:playerId",
  requireAdmin,
  async (req, res) => {
    try {
      await pool.query(
        `
        DELETE FROM lineups
        WHERE match_id = $1
        AND player_id = $2
        `,
        [
          req.params.matchId,
          req.params.playerId
        ]
      );

      res.json({ ok: true });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: "Heyətdən oyunçunu silmək mümkün olmadı"
      });
    }
  }
);

/* =========================
   TEAM OF THE WEEK
========================= */

app.get("/api/team-of-week", async (req, res) => {
  try {
    const week =
      String(req.query.week || "").trim() ||
      new Date().toISOString().slice(0, 10);

    const result = await pool.query(
      `
      SELECT
        team_of_week.*,
        players.name,
        players.number,
        players.photo,
        players.position,
        teams.name AS team_name
      FROM team_of_week
      JOIN players
        ON players.id = team_of_week.player_id
      LEFT JOIN teams
        ON teams.id = players.team_id
      WHERE team_of_week.week = $1
      ORDER BY
        CASE team_of_week.position
          WHEN 'Qapıçı' THEN 1
          WHEN 'Müdafiəçi' THEN 2
          WHEN 'Yarımmüdafiəçi' THEN 3
          WHEN 'Hücumçu' THEN 4
          ELSE 5
        END
      `,
      [week]
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Komanda həftəsini yükləmək mümkün olmadı"
    });
  }
});

app.post("/api/team-of-week", requireAdmin, async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      week,
      players
    } = req.body;

    if (!week || !Array.isArray(players)) {
      return res.status(400).json({
        error: "Həftə və oyunçular tələb olunur"
      });
    }

    if (players.length !== 11) {
      return res.status(400).json({
        error: "Komanda həftəsi tam 11 oyunçudan ibarət olmalıdır"
      });
    }

    const ids = players.map(
      p => Number(p.player_id)
    );

    if (
      ids.some(id => !Number.isInteger(id)) ||
      new Set(ids).size !== 11
    ) {
      return res.status(400).json({
        error: "11 fərqli oyunçu seçilməlidir"
      });
    }

    const goalkeeperCount =
      players.filter(
        p =>
          p.position === "Qapıçı"
      ).length;

    if (goalkeeperCount !== 1) {
      return res.status(400).json({
        error: "Dəqiq 1 qapıçı olmalıdır"
      });
    }

    await client.query("BEGIN");

    await client.query(
      `
      DELETE FROM team_of_week
      WHERE week = $1
      `,
      [week]
    );

    for (const player of players) {
      await client.query(
        `
        INSERT INTO team_of_week
        (week,player_id,position)
        VALUES ($1,$2,$3)
        `,
        [
          week,
          Number(player.player_id),
          player.position
        ]
      );
    }

    await client.query("COMMIT");

    res.json({
      ok: true,
      message: "Komanda həftəsi yadda saxlanıldı"
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error(error);

    res.status(500).json({
      error: "Komanda həftəsini saxlamaq mümkün olmadı"
    });
  } finally {
    client.release();
  }
});

/* =========================
   TRANSFERS
========================= */

app.get("/api/transfers", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        transfers.*,
        players.name AS player_name,
        old_team.name AS from_team_name,
        new_team.name AS to_team_name
      FROM transfers
      LEFT JOIN players
        ON players.id = transfers.player_id
      LEFT JOIN teams old_team
        ON old_team.id = transfers.from_team_id
      LEFT JOIN teams new_team
        ON new_team.id = transfers.to_team_id
      ORDER BY transfers.created_at DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Transferləri yükləmək mümkün olmadı"
    });
  }
});

app.post("/api/transfers", requireAdmin, async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      player_id,
      to_team_id
    } = req.body;

    if (!player_id || !to_team_id) {
      return res.status(400).json({
        error: "Oyunçu və yeni komanda seçilməlidir"
      });
    }

    await client.query("BEGIN");

    const playerResult = await client.query(
      `
      SELECT *
      FROM players
      WHERE id = $1
      FOR UPDATE
      `,
      [player_id]
    );

    if (!playerResult.rows.length) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        error: "Oyunçu tapılmadı"
      });
    }

    const player =
      playerResult.rows[0];

    if (
      String(player.team_id) ===
      String(to_team_id)
    ) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        error: "Oyunçu artıq bu komandadadır"
      });
    }

    const teamResult = await client.query(
      `
      SELECT id
      FROM teams
      WHERE id = $1
      `,
      [to_team_id]
    );

    if (!teamResult.rows.length) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        error: "Yeni komanda tapılmadı"
      });
    }

    await client.query(
      `
      INSERT INTO transfers
      (
        player_id,
        from_team_id,
        to_team_id
      )
      VALUES ($1,$2,$3)
      `,
      [
        player_id,
        player.team_id,
        to_team_id
      ]
    );

    await client.query(
      `
      UPDATE players
      SET team_id = $1
      WHERE id = $2
      `,
      [
        to_team_id,
        player_id
      ]
    );

    await client.query("COMMIT");

    res.json({
      ok: true,
      message: "Transfer uğurla tamamlandı"
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error(error);

    res.status(500).json({
      error: "Transfer etmək mümkün olmadı"
    });
  } finally {
    client.release();
  }
});

/* =========================
   MATCH EVENTS
========================= */

app.get("/api/events", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        events.*,
        players.name AS player_name,
        teams.name AS team_name
      FROM events
      LEFT JOIN players
        ON players.id = events.player_id
      LEFT JOIN teams
        ON teams.id = events.team_id
      ORDER BY events.created_at DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Hadisələri yükləmək mümkün olmadı"
    });
  }
});

app.post("/api/events", requireAdmin, async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      match_id,
      player_id,
      team_id,
      type,
      minute = 0
    } = req.body;

    const allowed = [
      "goal",
      "assist",
      "yellow_card",
      "red_card",
      "save"
    ];

    if (!allowed.includes(type)) {
      return res.status(400).json({
        error: "Yanlış hadisə növü"
      });
    }

    await client.query("BEGIN");

    await client.query(
      `
      INSERT INTO events
      (
        match_id,
        player_id,
        team_id,
        type,
        minute
      )
      VALUES ($1,$2,$3,$4,$5)
      `,
      [
        match_id || null,
        player_id || null,
        team_id || null,
        type,
        Number(minute) || 0
      ]
    );

    if (player_id) {
      const statMap = {
        goal: "goals",
        assist: "assists",
        yellow_card: "yellow_cards",
        red_card: "red_cards",
        save: "saves"
      };

      const column = statMap[type];

      if (column) {
        await client.query(
          `
          UPDATE players
          SET ${column} = ${column} + 1
          WHERE id = $1
          `,
          [player_id]
        );
      }
    }

    if (
      type === "goal" &&
      match_id &&
      team_id
    ) {
      const match = await client.query(
        `
        SELECT *
        FROM matches
        WHERE id = $1
        `,
        [match_id]
      );

      if (match.rows.length) {
        const m = match.rows[0];

        if (
          String(m.home_team_id) ===
          String(team_id)
        ) {
          await client.query(
            `
            UPDATE matches
            SET home_score = home_score + 1
            WHERE id = $1
            `,
            [match_id]
          );
        } else if (
          String(m.away_team_id) ===
          String(team_id)
        ) {
          await client.query(
            `
            UPDATE matches
            SET away_score = away_score + 1
            WHERE id = $1
            `,
            [match_id]
          );
        }
      }
    }

    await client.query("COMMIT");

    res.json({
      ok: true,
      message: "Hadisə əlavə edildi"
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error(error);

    res.status(500).json({
      error: "Hadisə əlavə etmək mümkün olmadı"
    });
  } finally {
    client.release();
  }
});

/* =========================
   RESET / RECALCULATE
========================= */

app.post(
  "/api/admin/recalculate-table",
  requireAdmin,
  async (req, res) => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      await client.query(`
        UPDATE teams
        SET
          played = 0,
          wins = 0,
          draws = 0,
          losses = 0,
          points = 0,
          goals_for = 0,
          goals_against = 0
      `);

      const matches = await client.query(`
        SELECT *
        FROM matches
        WHERE status = 'finished'
      `);

      for (const match of matches.rows) {
        const homeScore =
          Number(match.home_score) || 0;

        const awayScore =
          Number(match.away_score) || 0;

        await client.query(
          `
          UPDATE teams
          SET
            played = played + 1,
            goals_for = goals_for + $1,
            goals_against = goals_against + $2
          WHERE id = $3
          `,
          [
            homeScore,
            awayScore,
            match.home_team_id
          ]
        );

        await client.query(
          `
          UPDATE teams
          SET
            played = played + 1,
            goals_for = goals_for + $1,
            goals_against = goals_against + $2
          WHERE id = $3
          `,
          [
            awayScore,
            homeScore,
            match.away_team_id
          ]
        );

        if (homeScore > awayScore) {
          await client.query(
            `
            UPDATE teams
            SET wins = wins + 1,
                points = points + 3
            WHERE id = $1
            `,
            [match.home_team_id]
          );

          await client.query(
            `
            UPDATE teams
            SET losses = losses + 1
            WHERE id = $1
            `,
            [match.away_team_id]
          );
        } else if (
          awayScore > homeScore
        ) {
          await client.query(
            `
            UPDATE teams
            SET wins = wins + 1,
                points = points + 3
            WHERE id = $1
            `,
            [match.away_team_id]
          );

          await client.query(
            `
            UPDATE teams
            SET losses = losses + 1
            WHERE id = $1
            `,
            [match.home_team_id]
          );
        } else {
          await client.query(
            `
            UPDATE teams
            SET draws = draws + 1,
                points = points + 1
            WHERE id = $1
            `,
            [match.home_team_id]
          );

          await client.query(
            `
            UPDATE teams
            SET draws = draws + 1,
                points = points + 1
            WHERE id = $1
            `,
            [match.away_team_id]
          );
        }
      }

      await client.query("COMMIT");

      res.json({
        ok: true,
        message: "Turnir cədvəli yenidən hesablandı"
      });
    } catch (error) {
      await client.query("ROLLBACK");

      console.error(error);

      res.status(500).json({
        error: "Cədvəli hesablamaq mümkün olmadı"
      });
    } finally {
      client.release();
    }
  }
);

/* =========================
   STATE
   Köhnə frontend-lə uyğunluq
========================= */

app.get("/api/state", async (req, res) => {
  try {
    const [
      teams,
      players,
      matches,
      events
    ] = await Promise.all([
      pool.query(`
        SELECT *,
          (goals_for - goals_against)
          AS goal_difference
        FROM teams
        ORDER BY
          points DESC,
          goal_difference DESC,
          goals_for DESC,
          name ASC
      `),

      pool.query(`
        SELECT
          players.*,
          teams.name AS team_name
        FROM players
        LEFT JOIN teams
          ON teams.id = players.team_id
        ORDER BY players.name
      `),

      pool.query(`
        SELECT
          matches.*,
          home.name AS home_team_name,
          away.name AS away_team_name
        FROM matches
        LEFT JOIN teams home
          ON home.id = matches.home_team_id
        LEFT JOIN teams away
          ON away.id = matches.away_team_id
        ORDER BY matches.match_date ASC NULLS LAST
      `),

      pool.query(`
        SELECT *
        FROM events
        ORDER BY created_at DESC
      `)
    ]);

    res.json({
      teams: teams.rows,
      players: players.rows,
      matches: matches.rows,
      events: events.rows
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "State yüklənmədi"
    });
  }
});

/* =========================
   STATIC FILES
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
   START
========================= */

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(
        `AliScore server running on port ${PORT}`
      );
    });
  })
  .catch(error => {
    console.error(
      "Database initialization failed:",
      error
    );

    process.exit(1);
  });
