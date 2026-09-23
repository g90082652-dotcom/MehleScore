const express = require("express");
const { Pool } = require("pg");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const path = require("path");
const webpush = require("web-push");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());

for (const key of ["DATABASE_URL", "ADMIN_PASSWORD", "JWT_SECRET"]) {
  if (!process.env[key]) {
    console.error(`${key} is missing`);
    process.exit(1);
  }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const JWT_SECRET = process.env.JWT_SECRET;

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_EMAIL = process.env.VAPID_EMAIL || "";

const PUSH_ENABLED = !!(
  VAPID_PUBLIC_KEY &&
  VAPID_PRIVATE_KEY &&
  VAPID_EMAIL
);

if (PUSH_ENABLED) {
  webpush.setVapidDetails(
    VAPID_EMAIL,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
  console.log("REAL PUSH: ENABLED");
} else {
  console.log("REAL PUSH: DISABLED - add VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_EMAIL");
}

/* =========================================================
   AUTH
========================================================= */

function requireAdmin(req, res, next) {
  try {
    const token = req.cookies.aliscore_admin;
    if (!token) {
      return res.status(401).json({ ok: false, error: "Admin login required" });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded || !decoded.admin) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    next();
  } catch {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
}

/* =========================================================
   DATABASE HELPERS
========================================================= */

async function columnExists(table, column) {
  const r = await pool.query(`
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name=$1
      AND column_name=$2
    LIMIT 1
  `, [table, column]);

  return r.rows.length > 0;
}

async function addColumnIfMissing(table, column, definition) {
  if (!(await columnExists(table, column))) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`Added column ${table}.${column}`);
  }
}

/* =========================================================
   DATABASE
========================================================= */

async function initDatabase() {
  console.log("Checking AliScore database...");

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
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      number INTEGER DEFAULT 0,
      position TEXT DEFAULT 'Yarımmüdafiəçi',
      photo TEXT,
      goals INTEGER DEFAULT 0,
      assists INTEGER DEFAULT 0,
      saves INTEGER DEFAULT 0,
      yellow_cards INTEGER DEFAULT 0,
      red_cards INTEGER DEFAULT 0
    )
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
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS match_events (
      id SERIAL PRIMARY KEY,
      match_id INTEGER REFERENCES matches(id) ON DELETE CASCADE,
      player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      type TEXT NOT NULL,
      minute INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS team_of_week (
      id SERIAL PRIMARY KEY,
      week TEXT NOT NULL,
      player_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
      position TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS lineups (
      id SERIAL PRIMARY KEY,
      match_id INTEGER REFERENCES matches(id) ON DELETE CASCADE,
      player_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
      position TEXT NOT NULL,
      UNIQUE(match_id, player_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transfers (
      id SERIAL PRIMARY KEY,
      player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      from_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      to_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      endpoint TEXT UNIQUE NOT NULL,
      subscription JSONB NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  const teamColumns = [
    ["points", "INTEGER DEFAULT 0"],
    ["played", "INTEGER DEFAULT 0"],
    ["wins", "INTEGER DEFAULT 0"],
    ["draws", "INTEGER DEFAULT 0"],
    ["losses", "INTEGER DEFAULT 0"],
    ["goals_for", "INTEGER DEFAULT 0"],
    ["goals_against", "INTEGER DEFAULT 0"]
  ];

  for (const [c, d] of teamColumns) {
    await addColumnIfMissing("teams", c, d);
  }

  const playerColumns = [
    ["number", "INTEGER DEFAULT 0"],
    ["position", "TEXT DEFAULT 'Yarımmüdafiəçi'"],
    ["photo", "TEXT"],
    ["goals", "INTEGER DEFAULT 0"],
    ["assists", "INTEGER DEFAULT 0"],
    ["saves", "INTEGER DEFAULT 0"],
    ["yellow_cards", "INTEGER DEFAULT 0"],
    ["red_cards", "INTEGER DEFAULT 0"]
  ];

  for (const [c, d] of playerColumns) {
    await addColumnIfMissing("players", c, d);
  }

  const matchColumns = [
    ["home_score", "INTEGER DEFAULT 0"],
    ["away_score", "INTEGER DEFAULT 0"],
    ["match_date", "TIMESTAMP DEFAULT NOW()"],
    ["status", "TEXT DEFAULT 'scheduled'"]
  ];

  for (const [c, d] of matchColumns) {
    await addColumnIfMissing("matches", c, d);
  }

  const teamNames = [
    "Xirdalan United",
    "Xirdalan Wolves",
    "Neweli FK",
    "MSN FK",
    "Lotu pişiklər"
  ];

  for (const name of teamNames) {
    await pool.query(
      `INSERT INTO teams (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
      [name]
    );
  }

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
    ["Tofik", "Neweli FK"],
    ["Arda", "Neweli FK"],
    ["Veli", "Neweli FK"],
    ["Emil", "Neweli FK"],
    ["Kamran", "Lotu pişiklər"],
    ["Ayxan", "Lotu pişiklər"],
    ["Ramil", "Lotu pişiklər"]
  ];

  for (const [name, teamName] of seedPlayers) {
    const team = await pool.query(`SELECT id FROM teams WHERE name=$1`, [teamName]);
    if (!team.rows[0]) continue;

    await pool.query(`
      INSERT INTO players (name, team_id)
      SELECT $1, $2
      WHERE NOT EXISTS (
        SELECT 1 FROM players WHERE name=$1 AND team_id=$2
      )
    `, [name, team.rows[0].id]);
  }

  console.log("AliScore database ready");
}

/* =========================================================
   NOTIFICATIONS + PUSH
========================================================= */

async function sendPush(title, message, data = {}) {
  if (!PUSH_ENABLED) {
    console.log("Push skipped: VAPID variables are missing");
    return;
  }

  try {
    const result = await pool.query(`
      SELECT id, endpoint, subscription
      FROM push_subscriptions
    `);

    for (const row of result.rows) {
      try {
        await webpush.sendNotification(
          row.subscription,
          JSON.stringify({
            title,
            message,
            data
          })
        );
        console.log("Push sent:", row.id);
      } catch (error) {
        console.error(
          "Push send error:",
          error.statusCode || "",
          error.message
        );

        if (error.statusCode === 404 || error.statusCode === 410) {
          await pool.query(
            `DELETE FROM push_subscriptions WHERE id=$1`,
            [row.id]
          );
        }
      }
    }
  } catch (error) {
    console.error("SEND PUSH ERROR:", error);
  }
}

async function createNotification(title, message, data = {}) {
  await pool.query(
    `INSERT INTO notifications (title,message) VALUES ($1,$2)`,
    [title, message]
  );

  await sendPush(title, message, data);
}

/* =========================================================
   HEALTH
========================================================= */

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({
      ok: true,
      database: "connected",
      push: PUSH_ENABLED
    });
  } catch (error) {
    console.error("HEALTH ERROR:", error);
    res.status(500).json({
      ok: false,
      database: "error",
      push: PUSH_ENABLED,
      error: error.message
    });
  }
});

/* =========================================================
   ADMIN
========================================================= */

app.post("/api/admin/login", (req, res) => {
  try {
    if (req.body.password !== ADMIN_PASSWORD) {
      return res.status(401).json({ ok: false, error: "Wrong password" });
    }

    const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: "7d" });

    res.cookie("aliscore_admin", token, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.json({ ok: true, admin: true });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/admin/me", (req, res) => {
  try {
    const token = req.cookies.aliscore_admin;
    if (!token) return res.json({ ok: true, admin: false });

    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ ok: true, admin: !!decoded.admin });
  } catch {
    res.json({ ok: true, admin: false });
  }
});

app.post("/api/admin/logout", (req, res) => {
  res.clearCookie("aliscore_admin", {
    httpOnly: true,
    secure: true,
    sameSite: "lax"
  });
  res.json({ ok: true });
});

/* =========================================================
   TEAMS
========================================================= */

app.get("/api/teams", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id,name,
        COALESCE(points,0) AS points,
        COALESCE(played,0) AS played,
        COALESCE(wins,0) AS wins,
        COALESCE(draws,0) AS draws,
        COALESCE(losses,0) AS losses,
        COALESCE(goals_for,0) AS gf,
        COALESCE(goals_against,0) AS ga,
        COALESCE(goals_for,0)-COALESCE(goals_against,0) AS gd
      FROM teams
      ORDER BY points DESC,
        (COALESCE(goals_for,0)-COALESCE(goals_against,0)) DESC,
        goals_for DESC, name ASC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error("TEAMS GET ERROR:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/teams", requireAdmin, async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Komanda adı boş ola bilməz" });

    const result = await pool.query(`
      INSERT INTO teams
      (name,points,played,wins,draws,losses,goals_for,goals_against)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
    `, [
      name,
      Number(req.body.points) || 0,
      Number(req.body.played) || 0,
      Number(req.body.wins) || 0,
      Number(req.body.draws) || 0,
      Number(req.body.losses) || 0,
      Number(req.body.gf) || 0,
      Number(req.body.ga) || 0
    ]);

    res.json({ ok: true, team: result.rows[0] });
  } catch (error) {
    console.error("TEAM CREATE ERROR:", error);
    res.status(500).json({ error: error.message });
  }
});

async function updateTeam(req, res) {
  try {
    const id = Number(req.params.id);

    const result = await pool.query(`
      UPDATE teams SET
        name=COALESCE($1,name),
        points=COALESCE($2,points),
        played=COALESCE($3,played),
        wins=COALESCE($4,wins),
        draws=COALESCE($5,draws),
        losses=COALESCE($6,losses),
        goals_for=COALESCE($7,goals_for),
        goals_against=COALESCE($8,goals_against)
      WHERE id=$9
      RETURNING *
    `, [
      req.body.name ?? null,
      req.body.points === undefined ? null : Number(req.body.points),
      req.body.played === undefined ? null : Number(req.body.played),
      req.body.wins === undefined ? null : Number(req.body.wins),
      req.body.draws === undefined ? null : Number(req.body.draws),
      req.body.losses === undefined ? null : Number(req.body.losses),
      req.body.gf === undefined ? null : Number(req.body.gf),
      req.body.ga === undefined ? null : Number(req.body.ga),
      id
    ]);

    if (!result.rows[0]) return res.status(404).json({ error: "Team not found" });
    res.json({ ok: true, team: result.rows[0] });
  } catch (error) {
    console.error("TEAM UPDATE ERROR:", error);
    res.status(500).json({ error: error.message });
  }
}

app.put("/api/teams/:id", requireAdmin, updateTeam);
app.patch("/api/teams/:id", requireAdmin, updateTeam);

app.delete("/api/teams/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM teams WHERE id=$1`, [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (error) {
    console.error("TEAM DELETE ERROR:", error);
    res.status(500).json({ error: error.message });
  }
});

/* =========================================================
   PLAYERS
========================================================= */

app.get("/api/players", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.id,p.name,p.team_id,t.name AS team_name,
        COALESCE(p.number,0) AS number,
        COALESCE(p.position,'Yarımmüdafiəçi') AS position,
        p.photo,
        COALESCE(p.goals,0) AS goals,
        COALESCE(p.assists,0) AS assists,
        COALESCE(p.saves,0) AS saves,
        COALESCE(p.yellow_cards,0) AS yellow_cards,
        COALESCE(p.red_cards,0) AS red_cards
      FROM players p
      LEFT JOIN teams t ON t.id=p.team_id
      ORDER BY p.name
    `);
    res.json(result.rows);
  } catch (error) {
    console.error("PLAYERS GET ERROR:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/players", requireAdmin, async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Oyunçu adı boş ola bilməz" });

    const result = await pool.query(`
      INSERT INTO players (name,number,position,team_id,photo)
      VALUES ($1,$2,$3,$4,$5)
      RETURNING *
    `, [
      name,
      Number(req.body.number) || 0,
      req.body.position || "Yarımmüdafiəçi",
      req.body.team_id ? Number(req.body.team_id) : null,
      req.body.photo || null
    ]);

    res.json({ ok: true, player: result.rows[0] });
  } catch (error) {
    console.error("PLAYER CREATE ERROR:", error);
    res.status(500).json({ error: error.message });
  }
});

async function updatePlayer(req, res) {
  try {
    const id = Number(req.params.id);

    const result = await pool.query(`
      UPDATE players SET
        name=COALESCE($1,name),
        number=COALESCE($2,number),
        position=COALESCE($3,position),
        team_id=$4,
        photo=COALESCE($5,photo)
      WHERE id=$6
      RETURNING *
    `, [
      req.body.name ?? null,
      req.body.number === undefined ? null : Number(req.body.number),
      req.body.position ?? null,
      req.body.team_id ? Number(req.body.team_id) : null,
      req.body.photo ?? null,
      id
    ]);

    if (!result.rows[0]) return res.status(404).json({ error: "Player not found" });
    res.json({ ok: true, player: result.rows[0] });
  } catch (error) {
    console.error("PLAYER UPDATE ERROR:", error);
    res.status(500).json({ error: error.message });
  }
}

app.put("/api/players/:id", requireAdmin, updatePlayer);
app.patch("/api/players/:id", requireAdmin, updatePlayer);

app.delete("/api/players/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM players WHERE id=$1`, [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (error) {
    console.error("PLAYER DELETE ERROR:", error);
    res.status(500).json({ error: error.message });
  }
});

/* =========================================================
   MATCHES
========================================================= */

app.get("/api/matches", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT m.id,m.home_team_id,m.away_team_id,
        h.name AS home_name,a.name AS away_name,
        h.name AS home_team_name,a.name AS away_team_name,
        COALESCE(m.home_score,0) AS home_score,
        COALESCE(m.away_score,0) AS away_score,
        m.match_date,COALESCE(m.status,'scheduled') AS status
      FROM matches m
      LEFT JOIN teams h ON h.id=m.home_team_id
      LEFT JOIN teams a ON a.id=m.away_team_id
      ORDER BY m.match_date DESC,m.id DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error("MATCHES GET ERROR:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/matches", requireAdmin, async (req, res) => {
  try {
    const home = Number(req.body.home_team_id);
    const away = Number(req.body.away_team_id);

    if (!home || !away) return res.status(400).json({ error: "Komandalar seçilməlidir" });
    if (home === away) return res.status(400).json({ error: "Eyni komanda ilə matç olmaz" });

    const result = await pool.query(`
      INSERT INTO matches
      (home_team_id,away_team_id,match_date,status,home_score,away_score)
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *
    `, [
      home, away,
      req.body.match_date || new Date(),
      req.body.status || "scheduled",
      Math.max(0, Number(req.body.home_score) || 0),
      Math.max(0, Number(req.body.away_score) || 0)
    ]);

    res.json({ ok: true, match: result.rows[0] });
  } catch (error) {
    console.error("MATCH CREATE ERROR:", error);
    res.status(500).json({ error: error.message });
  }
});

async function updateMatch(req, res) {
  try {
    const id = Number(req.params.id);

    const result = await pool.query(`
      UPDATE matches SET
        home_score=COALESCE($1,home_score),
        away_score=COALESCE($2,away_score),
        status=COALESCE($3,status),
        match_date=COALESCE($4,match_date)
      WHERE id=$5
      RETURNING *
    `, [
      req.body.home_score === undefined ? null : Math.max(0, Number(req.body.home_score)),
      req.body.away_score === undefined ? null : Math.max(0, Number(req.body.away_score)),
      req.body.status ?? null,
      req.body.match_date ?? null,
      id
    ]);

    if (!result.rows[0]) return res.status(404).json({ error: "Match not found" });
    res.json({ ok: true, match: result.rows[0] });
  } catch (error) {
    console.error("MATCH UPDATE ERROR:", error);
    res.status(500).json({ error: error.message });
  }
}

app.put("/api/matches/:id", requireAdmin, updateMatch);
app.patch("/api/matches/:id", requireAdmin, updateMatch);

app.delete("/api/matches/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM matches WHERE id=$1`, [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (error) {
    console.error("MATCH DELETE ERROR:", error);
    res.status(500).json({ error: error.message });
  }
});

/* =========================================================
   MATCH EVENTS
========================================================= */

app.get("/api/matches/:id/events", async (req, res) => {
  try {
    const matchId = Number(req.params.id);
    if (!Number.isInteger(matchId)) return res.status(400).json({ error: "Invalid match id" });
    const result = await pool.query(`SELECT e.id,e.match_id,e.player_id,e.team_id,e.type,e.minute,e.created_at,p.name AS player_name,t.name AS team_name FROM match_events e LEFT JOIN players p ON p.id=e.player_id LEFT JOIN teams t ON t.id=e.team_id WHERE e.match_id=$1 ORDER BY e.minute ASC,e.id ASC`, [matchId]);
    res.json(result.rows);
  } catch (error) { console.error("EVENTS GET ERROR:", error); res.status(500).json({ error: error.message }); }
});

app.post("/api/matches/:id/events", requireAdmin, async (req, res) => {
  try {
    const type = req.body.type;
    if (!["goal","assist","save","yellow","red"].includes(type)) {
      return res.status(400).json({ error: "Invalid event type" });
    }

    const matchId = Number(req.params.id);
    const playerId = req.body.player_id ? Number(req.body.player_id) : null;
    const teamId = req.body.team_id ? Number(req.body.team_id) : null;
    const minute = Math.max(0, Number(req.body.minute) || 0);

    await pool.query(`
      INSERT INTO match_events
      (match_id,player_id,team_id,type,minute)
      VALUES ($1,$2,$3,$4,$5)
    `, [matchId, playerId, teamId, type, minute]);

    if (playerId) {
      const updates = {
        goal: "goals",
        assist: "assists",
        save: "saves",
        yellow: "yellow_cards",
        red: "red_cards"
      };

      if (updates[type]) {
        await pool.query(
          `UPDATE players SET ${updates[type]}=COALESCE(${updates[type]},0)+1 WHERE id=$1`,
          [playerId]
        );
      }

      if (["goal","yellow","red"].includes(type)) {
        const p = await pool.query(`SELECT name FROM players WHERE id=$1`, [playerId]);

        if (p.rows[0]) {
          let title;
          let message;

          if (type === "goal") {
            title = "⚽ Qol";
            message = `${p.rows[0].name} qol vurdu!`;
          } else if (type === "yellow") {
            title = "🟨 Sarı kart";
            message = `${p.rows[0].name} sarı kart aldı.`;
          } else {
            title = "🟥 Qırmızı kart";
            message = `${p.rows[0].name} qırmızı kart aldı.`;
          }

          await createNotification(title, message, {
            type,
            match_id: matchId,
            player_id: playerId,
            team_id: teamId
          });
        }
      }
    }

    res.json({ ok: true });
  } catch (error) {
    console.error("EVENT ERROR:", error);
    res.status(500).json({ error: error.message });
  }
});

/* =========================================================
   CARDS
========================================================= */

app.get("/api/cards", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.id,p.name,p.number,p.team_id,t.name AS team_name,
        COALESCE(p.yellow_cards,0) AS yellow_cards,
        COALESCE(p.red_cards,0) AS red_cards
      FROM players p
      LEFT JOIN teams t ON t.id=p.team_id
      ORDER BY p.name
    `);
    res.json(result.rows);
  } catch (error) {
    console.error("CARDS GET ERROR:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/cards/change", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.body.player_id);
    const amount = Number(req.body.amount !== undefined ? req.body.amount : req.body.delta);

    if (!["yellow","red"].includes(req.body.type)) {
      return res.status(400).json({ error: "Invalid card type" });
    }

    const column = req.body.type === "yellow" ? "yellow_cards" : "red_cards";

    const r = await pool.query(`SELECT ${column} AS value FROM players WHERE id=$1`, [id]);
    if (!r.rows[0]) return res.status(404).json({ error: "Player not found" });

    const value = Math.max(0, Number(r.rows[0].value || 0) + amount);

    await pool.query(`UPDATE players SET ${column}=$1 WHERE id=$2`, [value, id]);

    if (amount > 0) {
      const p = await pool.query(`SELECT name FROM players WHERE id=$1`, [id]);

      if (p.rows[0]) {
        const title = req.body.type === "yellow" ? "🟨 Sarı kart" : "🟥 Qırmızı kart";
        await createNotification(title, `${p.rows[0].name} kart aldı.`, {
          type: req.body.type,
          player_id: id
        });
      }
    }

    res.json({ ok: true, value });
  } catch (error) {
    console.error("CARD CHANGE ERROR:", error);
    res.status(500).json({ error: error.message });
  }
});

/* =========================================================
   STATISTICS
========================================================= */

app.get("/api/statistics", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.id,p.name,p.photo,t.name AS team_name,
        COALESCE(p.goals,0) AS goals,
        COALESCE(p.assists,0) AS assists,
        COALESCE(p.saves,0) AS saves,
        COALESCE(p.yellow_cards,0) AS yellow_cards,
        COALESCE(p.red_cards,0) AS red_cards
      FROM players p
      LEFT JOIN teams t ON t.id=p.team_id
      ORDER BY goals DESC,assists DESC,saves DESC,p.name
    `);

    res.json({
      players: result.rows,
      goals: [...result.rows].sort((a,b) => Number(b.goals)-Number(a.goals)),
      assists: [...result.rows].sort((a,b) => Number(b.assists)-Number(a.assists)),
      saves: [...result.rows].sort((a,b) => Number(b.saves)-Number(a.saves))
    });
  } catch (error) {
    console.error("STATISTICS ERROR:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/statistics/change", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.body.player_id);
    const amount = Number(req.body.amount !== undefined ? req.body.amount : req.body.delta);
    const allowed = ["goals","assists","saves"];

    if (!allowed.includes(req.body.type)) {
      return res.status(400).json({ error: "Invalid statistic" });
    }

    const column = req.body.type;
    const r = await pool.query(`SELECT ${column} AS value FROM players WHERE id=$1`, [id]);

    if (!r.rows[0]) return res.status(404).json({ error: "Player not found" });

    const value = Math.max(0, Number(r.rows[0].value || 0) + amount);

    await pool.query(`UPDATE players SET ${column}=$1 WHERE id=$2`, [value, id]);
    res.json({ ok: true, value });
  } catch (error) {
    console.error("STAT CHANGE ERROR:", error);
    res.status(500).json({ error: error.message });
  }
});

/* =========================================================
   NOTIFICATIONS
========================================================= */

app.get("/api/notifications", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id,title,message,created_at
      FROM notifications
      ORDER BY created_at DESC
      LIMIT 100
    `);
    res.json(result.rows);
  } catch (error) {
    console.error("NOTIFICATIONS ERROR:", error);
    res.status(500).json({ error: error.message });
  }
});

/* =========================================================
   TRANSFERS
========================================================= */

app.get("/api/transfers", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT tr.id,tr.player_id,p.name AS player_name,
        tr.from_team_id,ft.name AS from_team_name,
        tr.to_team_id,tt.name AS to_team_name,
        tr.created_at
      FROM transfers tr
      LEFT JOIN players p ON p.id=tr.player_id
      LEFT JOIN teams ft ON ft.id=tr.from_team_id
      LEFT JOIN teams tt ON tt.id=tr.to_team_id
      ORDER BY tr.created_at DESC
      LIMIT 100
    `);
    res.json(result.rows);
  } catch (error) {
    console.error("TRANSFERS GET ERROR:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/transfers", requireAdmin, async (req, res) => {
  try {
    const playerId = Number(req.body.player_id);
    const newTeamId = Number(req.body.to_team_id);

    const player = await pool.query(`
      SELECT p.id,p.name,p.team_id,t.name AS old_team
      FROM players p
      LEFT JOIN teams t ON t.id=p.team_id
      WHERE p.id=$1
    `, [playerId]);

    const team = await pool.query(`SELECT id,name FROM teams WHERE id=$1`, [newTeamId]);

    if (!player.rows[0] || !team.rows[0]) {
      return res.status(404).json({ error: "Player or team not found" });
    }

    if (Number(player.rows[0].team_id) === newTeamId) {
      return res.status(400).json({ error: "Oyunçu artıq bu komandadadır" });
    }

    const oldTeamId = player.rows[0].team_id;

    await pool.query(`UPDATE players SET team_id=$1 WHERE id=$2`, [newTeamId, playerId]);

    await pool.query(`
      INSERT INTO transfers (player_id,from_team_id,to_team_id)
      VALUES ($1,$2,$3)
    `, [playerId, oldTeamId, newTeamId]);

    await createNotification(
      "🔄 Transfer",
      `${player.rows[0].name} → ${team.rows[0].name}`,
      {
        type: "transfer",
        player_id: playerId,
        from_team_id: oldTeamId,
        to_team_id: newTeamId
      }
    );

    res.json({
      ok: true,
      message: `${player.rows[0].name} ${team.rows[0].name} komandasına keçirildi.`
    });
  } catch (error) {
    console.error("TRANSFER ERROR:", error);
    res.status(500).json({ error: error.message });
  }
});

/* =========================================================
   TEAM OF THE WEEK
========================================================= */

app.get("/api/team-of-week", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT tow.id,tow.week,tow.position,
        p.id AS player_id,p.name,p.number,p.photo,p.team_id,
        t.name AS team_name
      FROM team_of_week tow
      JOIN players p ON p.id=tow.player_id
      LEFT JOIN teams t ON t.id=p.team_id
      ORDER BY tow.id
    `);
    res.json(result.rows);
  } catch (error) {
    console.error("TEAM OF WEEK ERROR:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/team-of-week", requireAdmin, async (req,res) => {
  try {
    const {
      week,
      goalkeeper_id,
      defender_id,
      midfielder_id,
      attacker_id
    } = req.body;

    if (!goalkeeper_id || !defender_id || !midfielder_id || !attacker_id) {
      return res.status(400).json({
        error: "Bütün 4 mövqe seçilməlidir."
      });
    }

    const ids = [
      Number(goalkeeper_id),
      Number(defender_id),
      Number(midfielder_id),
      Number(attacker_id)
    ];

    if (new Set(ids).size !== 4) {
      return res.status(400).json({
        error: "Eyni oyunçu iki mövqedə seçilə bilməz."
      });
    }

    const existing = await pool.query(
      `SELECT id FROM players WHERE id=ANY($1::int[])`,
      [ids]
    );

    if (existing.rows.length !== 4) {
      return res.status(400).json({
        error: "One or more players do not exist"
      });
    }

    await pool.query(`DELETE FROM team_of_week`);

    await pool.query(
      `INSERT INTO team_of_week (week, player_id, position)
       VALUES
       ($1,$2,'Qapıçı'),
       ($1,$3,'Müdafiəçi'),
       ($1,$4,'Yarımmüdafiəçi'),
       ($1,$5,'Hücumçu')`,
      [
        week || "Bu həftə",
        Number(goalkeeper_id),
        Number(defender_id),
        Number(midfielder_id),
        Number(attacker_id)
      ]
    );

    await createNotification(
      "⭐ Komanda həftəsi",
      "Yeni Komanda həftəsi seçildi!",
      {type:"team_of_week"}
    );

    res.json({ok:true});
  } catch (e) {
    console.error("SAVE TEAM OF WEEK ERROR:", e);
    res.status(500).json({error:e.message});
  }
});

app.get("/api/lineups/:id", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT l.id,l.match_id,l.player_id,l.position,
        p.name,p.number,p.photo,p.team_id,t.name AS team_name
      FROM lineups l
      JOIN players p ON p.id=l.player_id
      LEFT JOIN teams t ON t.id=p.team_id
      WHERE l.match_id=$1
      ORDER BY l.id
    `, [Number(req.params.id)]);

    res.json(result.rows);
  } catch (error) {
    console.error("LINEUPS ERROR:", error);
    res.status(500).json({ error: error.message });
  }
});

/* =========================================================
   PUSH API
========================================================= */

app.get("/api/push/public-key", (req, res) => {
  res.json({
    ok: true,
    enabled: PUSH_ENABLED,
    publicKey: PUSH_ENABLED ? VAPID_PUBLIC_KEY : null
  });
});

app.post("/api/push/subscribe", async (req, res) => {
  try {
    const subscription = req.body;

    if (
      !subscription ||
      !subscription.endpoint ||
      !subscription.keys ||
      !subscription.keys.p256dh ||
      !subscription.keys.auth
    ) {
      return res.status(400).json({
        ok: false,
        error: "Invalid push subscription"
      });
    }

    await pool.query(`
      INSERT INTO push_subscriptions (endpoint,subscription)
      VALUES ($1,$2)
      ON CONFLICT (endpoint)
      DO UPDATE SET subscription=EXCLUDED.subscription
    `, [
      subscription.endpoint,
      JSON.stringify(subscription)
    ]);

    res.json({ ok: true, subscribed: true });
  } catch (error) {
    console.error("PUSH SUBSCRIBE ERROR:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/push/test", requireAdmin, async (req, res) => {
  try {
    await createNotification(
      "🔔 AliScore",
      "Push bildirişləri işləyir!",
      { type: "test" }
    );

    res.json({
      ok: true,
      push: PUSH_ENABLED
    });
  } catch (error) {
    console.error("TEST PUSH ERROR:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/* =========================================================
   SERVICE WORKER
========================================================= */

app.get("/service-worker.js", (req, res) => {
  res.type("application/javascript").send(`
    self.addEventListener("install", event => {
      self.skipWaiting();
    });

    self.addEventListener("activate", event => {
      event.waitUntil(self.clients.claim());
    });

    self.addEventListener("push", event => {
      let data = {};

      try {
        data = event.data ? event.data.json() : {};
      } catch (e) {
        data = {
          title: "AliScore",
          message: event.data ? event.data.text() : ""
        };
      }

      const title = data.title || "AliScore";

      const options = {
        body: data.message || "Yeni bildiriş var",
        data: data.data || {},
        vibrate: [200,100,200],
        requireInteraction: false
      };

      event.waitUntil(
        self.registration.showNotification(title, options)
      );
    });

    self.addEventListener("notificationclick", event => {
      event.notification.close();

      event.waitUntil(
        self.clients.matchAll({
          type: "window",
          includeUncontrolled: true
        }).then(clientList => {
          for (const client of clientList) {
            if ("focus" in client) return client.focus();
          }

          if (self.clients.openWindow) {
            return self.clients.openWindow("/");
          }
        })
      );
    });
  `);
});

/* =========================================================
   STATIC FILES / FRONTEND
========================================================= */

app.use(express.static(path.join(__dirname, "public")));

app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({
      ok: false,
      error: "API route not found"
    });
  }
  next();
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((error, req, res, next) => {
  console.error("EXPRESS ERROR:", error);

  if (res.headersSent) return next(error);

  res.status(500).json({
    ok: false,
    error: error.message || "Server error"
  });
});

/* =========================================================
   START
========================================================= */

async function start() {
  try {
    await initDatabase();
    await pool.query("SELECT 1");

    app.listen(PORT, "0.0.0.0", () => {
      console.log("=================================");
      console.log("AliScore started");
      console.log("PORT:", PORT);
      console.log("DATABASE: connected");
      console.log("PUSH:", PUSH_ENABLED ? "enabled" : "disabled");
      console.log("=================================");
    });
  } catch (error) {
    console.error("=================================");
    console.error("ALI SCORE START ERROR");
    console.error(error);
    console.error("=================================");
    process.exit(1);
  }
}

start();
