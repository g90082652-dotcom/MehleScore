const express = require("express");
const { Pool } = require("pg");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const path = require("path");
const webpush = require("web-push");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: "15mb" }));
app.use(cookieParser());

/* =========================
   ENV
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
  ssl: { rejectUnauthorized: false }
});

/* =========================
   PUSH
========================= */

const pushEnabled =
  !!process.env.VAPID_PUBLIC_KEY &&
  !!process.env.VAPID_PRIVATE_KEY;

if (pushEnabled) {
  webpush.setVapidDetails(
    "mailto:aliscore@example.com",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  console.log("Push notifications enabled");
} else {
  console.log("Push notifications disabled: VAPID keys missing");
}

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

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      endpoint TEXT NOT NULL UNIQUE,
      subscription JSONB NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  /* =========================
     OLD DATABASE COMPATIBILITY
  ========================= */

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
      `
      SELECT id
      FROM teams
      WHERE name = $1
      `,
      [teamName]
    );

    if (!team.rows.length) continue;

    const teamId = team.rows[0].id;

    await pool.query(
      `
      INSERT INTO players
      (
        name,
        team_id,
        number,
        position
      )
      SELECT
        $1,
        $2,
        0,
        'Yarımmüdafiəçi'
      WHERE NOT EXISTS (
        SELECT 1
        FROM players
        WHERE name = $1
        AND team_id = $2
      )
      `,
      [
        playerName,
        teamId
      ]
    );
  }

  console.log("Database ready");
}

/* =========================
   ADMIN AUTH
========================= */

function createAdminToken() {

  return jwt.sign(
    { role: "admin" },
    process.env.JWT_SECRET,
    {
      expiresIn: "7d"
    }
  );
}

function requireAdmin(req, res, next) {

  try {

    const token =
      req.cookies.aliscore_admin;

    if (!token) {

      return res.status(401).json({
        error: "Admin girişi tələb olunur"
      });
    }

    const decoded =
      jwt.verify(
        token,
        process.env.JWT_SECRET
      );

    if (decoded.role !== "admin") {

      return res.status(403).json({
        error: "İcazə yoxdur"
      });
    }

    next();

  } catch {

    return res.status(401).json({
      error: "Admin sessiyası etibarsızdır"
    });
  }
}

app.post(
  "/api/admin/login",
  (req, res) => {

    const password =
      String(
        req.body?.password || ""
      );

    if (!password) {

      return res.status(400).json({
        error: "Şifrə daxil edin"
      });
    }

    if (
      password !==
      process.env.ADMIN_PASSWORD
    ) {

      return res.status(401).json({
        error: "Şifrə yanlışdır"
      });
    }

    const token =
      createAdminToken();

    res.cookie(
      "aliscore_admin",
      token,
      {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        maxAge:
          7 *
          24 *
          60 *
          60 *
          1000,
        path: "/"
      }
    );

    res.json({
      ok: true,
      message:
        "Admin giriş uğurludur"
    });
  }
);

app.get(
  "/api/admin/me",
  (req, res) => {

    try {

      const token =
        req.cookies.aliscore_admin;

      if (!token) {

        return res.json({
          loggedIn: false
        });
      }

      const decoded =
        jwt.verify(
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
  }
);

app.post(
  "/api/admin/logout",
  (req, res) => {

    res.clearCookie(
      "aliscore_admin",
      {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/"
      }
    );

    res.json({
      ok: true
    });
  }
);

/* =========================
   HEALTH
========================= */

app.get(
  "/api/health",
  async (req, res) => {

    try {

      await pool.query(
        "SELECT NOW()"
      );

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
  }
);

/* =========================
   PUSH PUBLIC KEY
========================= */

app.get(
  "/api/push/public-key",
  (req, res) => {

    if (!pushEnabled) {

      return res.status(503).json({
        error:
          "Push bildirişləri aktiv deyil"
      });
    }

    res.json({
      publicKey:
        process.env.VAPID_PUBLIC_KEY
    });
  }
);

/* =========================
   PUSH SUBSCRIBE
========================= */

app.post(
  "/api/push/subscribe",
  async (req, res) => {

    try {

      if (!pushEnabled) {

        return res.status(503).json({
          error:
            "Push bildirişləri aktiv deyil"
        });
      }

      const subscription =
        req.body;

      if (
        !subscription ||
        !subscription.endpoint
      ) {

        return res.status(400).json({
          error:
            "Push subscription yanlışdır"
        });
      }

      await pool.query(
        `
        INSERT INTO push_subscriptions
        (
          endpoint,
          subscription
        )
        VALUES ($1,$2)
        ON CONFLICT (endpoint)
        DO UPDATE SET
          subscription = EXCLUDED.subscription
        `,
        [
          subscription.endpoint,
          JSON.stringify(subscription)
        ]
      );

      res.json({
        ok: true
      });

    } catch (error) {

      console.error(error);

      res.status(500).json({
        error:
          "Push subscription saxlamaq mümkün olmadı"
      });
    }
  }
);

/* =========================
   SEND PUSH
========================= */

async function sendPushNotification(
  title,
  body,
  url = "/"
) {

  if (!pushEnabled) {
    return;
  }

  try {

    const result =
      await pool.query(
        `
        SELECT *
        FROM push_subscriptions
        `
      );

    const payload =
      JSON.stringify({
        title,
        body,
        url,
        icon: "/icon-192.png",
        badge: "/icon-192.png"
      });

    for (const row of result.rows) {

      try {

        await webpush.sendNotification(
          row.subscription,
          payload
        );

      } catch (error) {

        if (
          error.statusCode === 404 ||
          error.statusCode === 410
        ) {

          await pool.query(
            `
            DELETE FROM push_subscriptions
            WHERE endpoint = $1
            `,
            [row.endpoint]
          );
        } else {

          console.error(
            "Push send error:",
            error.message
          );
        }
      }
    }

  } catch (error) {

    console.error(
      "Push notification error:",
      error
    );
  }
}

/* =========================
   TEAMS
========================= */

app.get(
  "/api/teams",
  async (req, res) => {

    try {

      const result =
        await pool.query(`
          SELECT *,
            (
              goals_for -
              goals_against
            ) AS goal_difference
          FROM teams
          ORDER BY
            points DESC,
            goal_difference DESC,
            goals_for DESC,
            name ASC
        `);

      res.json(
        result.rows
      );

    } catch (error) {

      console.error(error);

      res.status(500).json({
        error:
          "Komandaları yükləmək mümkün olmadı"
      });
    }
  }
);

app.post(
  "/api/teams",
  requireAdmin,
  async (req, res) => {

    try {

      const name =
        String(
          req.body?.name || ""
        ).trim();

      if (!name) {

        return res.status(400).json({
          error:
            "Komanda adı tələb olunur"
        });
      }

      const result =
        await pool.query(
          `
          INSERT INTO teams
          (name)
          VALUES ($1)
          RETURNING *
          `,
          [name]
        );

      res.status(201).json(
        result.rows[0]
      );

    } catch (error) {

      console.error(error);

      res.status(500).json({
        error:
          "Komanda əlavə etmək mümkün olmadı"
      });
    }
  }
);

app.patch(
  "/api/teams/:id",
  requireAdmin,
  async (req, res) => {

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

      const result =
        await pool.query(
          `
          UPDATE teams
          SET
            name =
              COALESCE($1,name),

            points =
              CO
