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
  ssl: {
    rejectUnauthorized: false
  }
});

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const JWT_SECRET = process.env.JWT_SECRET;

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_EMAIL = process.env.VAPID_EMAIL || "";

const PUSH_ENABLED =
  !!VAPID_PUBLIC_KEY &&
  !!VAPID_PRIVATE_KEY &&
  !!VAPID_EMAIL;

if (PUSH_ENABLED) {
  webpush.setVapidDetails(
    VAPID_EMAIL,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );

  console.log("REAL PUSH: ENABLED");
} else {
  console.log(
    "REAL PUSH: DISABLED - VAPID variables missing"
  );
}

/* =========================================================
   AUTH
========================================================= */

function requireAdmin(req, res, next) {
  try {
    const token = req.cookies.aliscore_admin;

    if (!token) {
      return res.status(401).json({
        ok: false,
        error: "Admin login required"
      });
    }

    const decoded = jwt.verify(
      token,
      JWT_SECRET
    );

    if (!decoded || !decoded.admin) {
      return res.status(401).json({
        ok: false,
        error: "Unauthorized"
      });
    }

    next();
  } catch (error) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized"
    });
  }
}

/* =========================================================
   DATABASE HELPERS
========================================================= */

async function columnExists(
  table,
  column
) {
  const result = await pool.query(
    `
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name=$1
      AND column_name=$2
    LIMIT 1
    `,
    [
      table,
      column
    ]
  );

  return result.rows.length > 0;
}

async function addColumnIfMissing(
  table,
  column,
  definition
) {
  const exists =
    await columnExists(
      table,
      column
    );

  if (!exists) {
    await pool.query(
      `ALTER TABLE ${table}
       ADD COLUMN ${column} ${definition}`
    );

    console.log(
      `Added column ${table}.${column}`
    );
  }
}

/* =========================================================
   DATABASE INIT
========================================================= */

async function initDatabase() {
  console.log(
    "Checking AliScore database..."
  );

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
      team_id INTEGER
        REFERENCES teams(id)
        ON DELETE SET NULL,
      number INTEGER DEFAULT 0,
      position TEXT
        DEFAULT 'Yarımmüdafiəçi',
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
      home_team_id INTEGER
        REFERENCES teams(id)
        ON DELETE CASCADE,
      away_team_id INTEGER
        REFERENCES teams(id)
        ON DELETE CASCADE,
      home_score INTEGER DEFAULT 0,
      away_score INTEGER DEFAULT 0,
      match_date TIMESTAMP
        DEFAULT NOW(),
      status TEXT
        DEFAULT 'scheduled'
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS match_events (
      id SERIAL PRIMARY KEY,
      match_id INTEGER
        REFERENCES matches(id)
        ON DELETE CASCADE,
      player_id INTEGER
        REFERENCES players(id)
        ON DELETE SET NULL,
      team_id INTEGER
        REFERENCES teams(id)
        ON DELETE SET NULL,
      type TEXT NOT NULL,
      minute INTEGER DEFAULT 0,
      created_at TIMESTAMP
        DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMP
        DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS team_of_week (
      id SERIAL PRIMARY KEY,
      week TEXT NOT NULL,
      player_id INTEGER
        REFERENCES players(id)
        ON DELETE CASCADE,
      position TEXT NOT NULL,
      created_at TIMESTAMP
        DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS lineups (
      id SERIAL PRIMARY KEY,
      match_id INTEGER
        REFERENCES matches(id)
        ON DELETE CASCADE,
      player_id INTEGER
        REFERENCES players(id)
        ON DELETE CASCADE,
      position TEXT NOT NULL,
      UNIQUE(match_id, player_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transfers (
      id SERIAL PRIMARY KEY,
      player_id INTEGER
        REFERENCES players(id)
        ON DELETE SET NULL,
      from_team_id INTEGER
        REFERENCES teams(id)
        ON DELETE SET NULL,
      to_team_id INTEGER
        REFERENCES teams(id)
        ON DELETE SET NULL,
      created_at TIMESTAMP
        DEFAULT NOW()
    )
  `);

  /* REAL PUSH SUBSCRIPTIONS */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      endpoint TEXT UNIQUE NOT NULL,
      subscription JSONB NOT NULL,
      created_at TIMESTAMP
        DEFAULT NOW()
    )
  `);

  /* =======================================================
     MIGRATIONS
  ======================================================= */

  const teamColumns = [
    ["points", "INTEGER DEFAULT 0"],
    ["played", "INTEGER DEFAULT 0"],
    ["wins", "INTEGER DEFAULT 0"],
    ["draws", "INTEGER DEFAULT 0"],
    ["losses", "INTEGER DEFAULT 0"],
    ["goals_for", "INTEGER DEFAULT 0"],
    ["goals_against", "INTEGER DEFAULT 0"]
  ];

  for (
    const [column, definition]
    of teamColumns
  ) {
    await addColumnIfMissing(
      "teams",
      column,
      definition
    );
  }

  const playerColumns = [
    ["number", "INTEGER DEFAULT 0"],
    [
      "position",
      "TEXT DEFAULT 'Yarımmüdafiəçi'"
    ],
    ["photo", "TEXT"],
    ["goals", "INTEGER DEFAULT 0"],
    ["assists", "INTEGER DEFAULT 0"],
    ["saves", "INTEGER DEFAULT 0"],
    ["yellow_cards", "INTEGER DEFAULT 0"],
    ["red_cards", "INTEGER DEFAULT 0"]
  ];

  for (
    const [column, definition]
    of playerColumns
  ) {
    await addColumnIfMissing(
      "players",
      column,
      definition
    );
  }

  const matchColumns = [
    ["home_score", "INTEGER DEFAULT 0"],
    ["away_score", "INTEGER DEFAULT 0"],
    [
      "match_date",
      "TIMESTAMP DEFAULT NOW()"
    ],
    [
      "status",
      "TEXT DEFAULT 'scheduled'"
    ]
  ];

  for (
    const [column, definition]
    of matchColumns
  ) {
    await addColumnIfMissing(
      "matches",
      column,
      definition
    );
  }

  /* =======================================================
     TEAMS SEED
  ======================================================= */

  const teamNames = [
    "Xirdalan United",
    "Xirdalan Wolves",
    "Neweli FK",
    "MSN FK",
    "Lotu pişiklər"
  ];

  for (const name of teamNames) {
    await pool.query(
      `
      INSERT INTO teams (name)
      VALUES ($1)
      ON CONFLICT (name)
      DO NOTHING
      `,
      [name]
    );
  }

  /* =======================================================
     PLAYERS SEED
  ======================================================= */

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

  for (
    const [name, teamName]
    of seedPlayers
  ) {
    const team = await pool.query(
      `
      SELECT id
      FROM teams
      WHERE name=$1
      `,
      [teamName]
    );

    if (!team.rows[0]) {
      continue;
    }

    await pool.query(
      `
      INSERT INTO players
      (name,team_id)
      SELECT $1,$2
      WHERE NOT EXISTS (
        SELECT 1
        FROM players
        WHERE name=$1
          AND team_id=$2
      )
      `,
      [
        name,
        team.rows[0].id
      ]
    );
  }

  console.log(
    "AliScore database ready"
  );
}

/* =========================================================
   REAL PUSH
========================================================= */

async function sendPush(
  title,
  message,
  data = {}
) {
  if (!PUSH_ENABLED) {
    console.log(
      "Push skipped: VAPID not configured"
    );
    return;
  }

  try {
    const result =
      await pool.query(`
        SELECT
          id,
          endpoint,
          subscription
        FROM push_subscriptions
      `);

    for (
      const row
      of result.rows
    ) {
      try {
        await webpush.sendNotification(
          row.subscription,
          JSON.stringify({
            title,
            message,
            data
          })
        );

        console.log(
          "Push sent:",
          row.id
        );
      } catch (error) {
        console.error(
          "Push send error:",
          error.statusCode || "",
          error.message
        );

        if (
          error.statusCode === 404 ||
          error.statusCode === 410
        ) {
          await pool.query(
            `
            DELETE FROM
            push_subscriptions
            WHERE id=$1
            `,
            [row.id]
          );

          console.log(
            "Removed expired subscription:",
            row.id
          );
        }
      }
    }
  } catch (error) {
    console.error(
      "SEND PUSH ERROR:",
      error
    );
  }
}

async function createNotification(
  title,
  message,
  data = {}
) {
  await pool.query(
    `
    INSERT INTO notifications
    (title,message)
    VALUES ($1,$2)
    `,
    [
      title,
      message
    ]
  );

  await sendPush(
    title,
    message,
    data
  );
}

/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/api/health",
  async (req, res) => {
    try {
      await pool.query(
        "SELECT 1"
      );

      res.json({
        ok: true,
        database: "connected",
        push: PUSH_ENABLED
      });
    } catch (error) {
      console.error(
        "HEALTH ERROR:",
        error
      );

      res.status(500).json({
        ok: false,
        database: "error",
        push: PUSH_ENABLED,
        error: error.message
      });
    }
  }
);

/* =========================================================
   ADMIN
========================================================= */

app.post(
  "/api/admin/login",
  (req, res) => {
    try {
      if (
        req.body.password !==
        ADMIN_PASSWORD
      ) {
        return res.status(401).json({
          ok: false,
          error: "Wrong password"
        });
      }

      const token =
        jwt.sign(
          { admin: true },
          JWT_SECRET,
          {
            expiresIn: "7d"
          }
        );

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
            1000
        }
      );

      res.json({
        ok: true,
        admin: true
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        ok: false,
        error: error.message
      });
    }
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
          ok: true,
          admin: false
        });
      }

      const decoded =
        jwt.verify(
          token,
          JWT_SECRET
        );

      res.json({
        ok: true,
        admin:
          !!decoded.admin
      });
    } catch {
      res.json({
        ok: true,
        admin: false
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
        sameSite: "lax"
      }
    );

    res.json({
      ok: true
    });
  }
);

/* =========================================================
   TEAMS
========================================================= */

app.get(
  "/api/teams",
  async (req, res) => {
    try {
      const result =
        await pool.query(`
          SELECT
            id,
            name,
            COALESCE(points,0)
              AS points,
            COALESCE(played,0)
              AS played,
            COALESCE(wins,0)
              AS wins,
            COALESCE(draws,0)
              AS draws,
            COALESCE(losses,0)
              AS losses,
            COALESCE(goals_for,0)
              AS gf,
            COALESCE(goals_against,0)
              AS ga,
            COALESCE(goals_for,0)
              -
            COALESCE(goals_against,0)
              AS gd
          FROM teams
          ORDER BY
            points DESC,
            (
              COALESCE(goals_for,0)
              -
              COALESCE(goals_against,0)
            ) DESC,
            goals_for DESC,
            name ASC
        `);

      res.json(
        result.rows
      );
    } catch (error) {
      console.error(
        "TEAMS GET ERROR:",
        error
      );

      res.status(500).json({
        ok: false,
        error: error.message
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
          req.body.name || ""
        ).trim();

      if (!name) {
        return res.status(400).json({
          error:
            "Komanda adı boş ola bilməz"
        });
      }

      const result =
        await pool.query(`
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
          VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8)
          RETURNING *
        `, [
          name,
          Number(
            req.body.points
          ) || 0,
          Number(
            req.body.played
          ) || 0,
          Number(
            req.body.wins
          ) || 0,
          Number(
            req.body.draws
          ) || 0,
          Number(
            req.body.losses
          ) || 0,
          Number(
            req.body.gf
          ) || 0,
          Number(
            req.body.ga
          ) || 0
        ]);

      res.json({
        ok: true,
        team:
          result.rows[0]
      });
    } catch (error) {
      console.error(
        "TEAM CREATE ERROR:",
        error
      );

      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

async function updateTeam(
  req,
  res
) {
  try {
    const id =
      Number(req.params.id);

    const result =
      await pool.query(`
        UPDATE teams
        SET
          name =
            COALESCE(
              $1,name
            ),
          points =
            COALESCE(
              $2,points
            ),
          played =
            COALESCE(
              $3,played
            ),
          wins =
            COALESCE(
              $4,wins
            ),
          draws =
            COALESCE(
              $5,draws
            ),
          losses =
            COALESCE(
              $6,losses
            ),
          goals_for =
            COALESCE(
              $7,goals_for
            ),
          goals_against =
            COALESCE(
              $8,goals_against
            )
        WHERE id=$9
        RETURNING *
      `,
      [
        req.body.name ??
          null,

        req.body.points ===
        undefined
          ? null
          : Number(
              req.body.points
            ),

        req.body.played ===
        undefined
          ? null
          : Number(
              req.body.played
            ),

        req.body.wins ===
        undefined
          ? null
          : Number(
              req.body.wins
            ),

        req.body.draws ===
        undefined
          ? null
          : Number(
              req.body.draws
            ),

        req.body.losses ===
        undefined
          ? null
          : Number(
              req.body.losses
            ),

        req.body.gf ===
        undefined
          ? null
          : Number(
              req.body.gf
            ),

        req.body.ga ===
        undefined
          ? null
          : Number(
              req.body.ga
            ),

        id
      ]
    );

    if (!result.rows[0]) {
      return res.status(404).json({
        error:
          "Team not found"
      });
    }

    res.json({
      ok: true,
      team:
        result.rows[0]
    });
  } catch (error) {
    console.error(
      "TEAM UPDATE ERROR:",
      error
    );

    res.status(500).json({
      error:
        error.message
    });
  }
}

app.put(
  "/api/teams/:id",
  requireAdmin,
  updateTeam
);

app.patch(
  "/api/teams/:id",
  requireAdmin,
  updateTeam
);

app.delete(
  "/api/teams/:id",
  requireAdmin,
  async (req, res) => {
    try {
      await pool.query(
        `
        DELETE FROM teams
        WHERE id=$1
        `,
        [
          Number(
            req.params.id
          )
        ]
      );

      res.json({
        ok: true
      });
    } catch (error) {
      console.error(
        "TEAM DELETE ERROR:",
        error
      );

      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   PLAYERS
========================================================= */

app.get(
  "/api/players",
  async (req, res) => {
    try {
      const result =
        await pool.query(`
          SELECT
            p.id,
            p.name,
            p.team_id,
            t.name AS team_name,
            COALESCE(
              p.number,0
            ) AS number,
            COALESCE(
              p.position,
              'Yarımmüdafiəçi'
            ) AS position,
            p.photo,
            COALESCE(
              p.goals,0
            ) AS goals,
            COALESCE(
              p.assists,0
            ) AS assists,
            COALESCE(
              p.saves,0
            ) AS saves,
            COALESCE(
              p.yellow_cards,0
            ) AS yellow_cards,
            COALESCE(
              p.red_cards,0
            ) AS red_cards
          FROM players p
          LEFT JOIN teams t
            ON t.id=p.team_id
          ORDER BY p.name
        `);

      res.json(
        result.rows
      );
    } catch (error) {
      console.error(
        "PLAYERS GET ERROR:",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

app.post(
  "/api/players",
  requireAdmin,
  async (req, res) => {
    try {
      const name =
        String(
          req.body.name || ""
        ).trim();

      if (!name) {
        return res.status(400).json({
          error:
            "Oyunçu adı boş ola bilməz"
        });
      }

      const result =
        await pool.query(`
          INSERT INTO players
          (
            name,
            number,
            position,
            team_id,
            photo
          )
          VALUES
          ($1,$2,$3,$4,$5)
          RETURNING *
        `,
        [
          name,
          Number(
            req.body.number
          ) || 0,
          req.body.position ||
            "Yarımmüdafiəçi",
          req.body.team_id
            ? Number(
                req.body.team_id
              )
            : null,
          req.body.photo ||
            null
        ]);

      res.json({
        ok: true,
        player:
          result.rows[0]
      });
    } catch (error) {
      console.error(
        "PLAYER CREATE ERROR:",
        error
      );

      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

async function updatePlayer(
  req,
  res
) {
  try {
    const id =
      Number(req.params.id);

    const result =
      await pool.query(`
        UPDATE players
        SET
          name =
            COALESCE(
              $1,name
            ),
          number =
            COALESCE(
              $2,number
            ),
          position =
            COALESCE(
              $3,position
            ),
          team_id=$4,
          photo =
            COALESCE(
              $5,photo
            )
        WHERE id=$6
        RETURNING *
      `,
      [
        req.body.name ??
          null,

        req.body.number ===
        undefined
          ? null
          : Number(
              req.body.number
            ),

        req.body.position ??
          null,

        req.body.team_id
          ? Number(
              req.body.team_id
            )
          : null,

        req.body.photo ??
          null,

        id
      ]
    );

    if (!result.rows[0]) {
      return res.status(404).json({
        error:
          "Player not found"
      });
    }

    res.json({
      ok: true,
      player:
        result.rows[0]
    });
  } catch (error) {
    console.error(
      "PLAYER UPDATE ERROR:",
      error
    );

    res.status(500).json({
      error:
        error.message
    });
  }
}

app.put(
  "/api/players/:id",
  requireAdmin,
  updatePlayer
);

app.patch(
  "/api/players/:id",
  requireAdmin,
  updatePlayer
);

app.delete(
  "/api/players/:id",
  requireAdmin,
  async (req, res) => {
    try {
      await pool.query(
        `
        DELETE FROM players
        WHERE id=$1
        `,
        [
          Number(
            req.params.id
          )
        ]
      );

      res.json({
        ok: true
      });
    } catch (error) {
      console.error(
        "PLAYER DELETE ERROR:",
        error
      );

      res.status(500).json({
        error:
          error.message
      });
    }
  }
);
/* =========================================================
   MATCHES
========================================================= */

app.get("/api/matches", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        m.id,
        m.home_team_id,
        ht.name AS home_name,
        m.away_team_id,
        at.name AS away_name,
        ht.name AS home_team_name,
        at.name AS away_team_name,
        COALESCE(m.home_score, 0) AS home_score,
        COALESCE(m.away_score, 0) AS away_score,
        m.match_date,
        COALESCE(m.status, 'scheduled') AS status
      FROM matches m
      LEFT JOIN teams ht
        ON ht.id = m.home_team_id
      LEFT JOIN teams at
        ON at.id = m.away_team_id
      ORDER BY m.match_date DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("MATCHES GET ERROR:", error);

    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});
  
app.post(
  "/api/matches",
  requireAdmin,
  async (req,res)=>{
    try {
      const homeTeamId =
        Number(req.body.home_team_id);

      const awayTeamId =
        Number(req.body.away_team_id);

      if (
        !homeTeamId ||
        !awayTeamId ||
        homeTeamId === awayTeamId
      ) {
        return res.status(400).json({
          error:"İki fərqli komanda seçilməlidir"
        });
      }

      const result =
        await pool.query(`
          INSERT INTO matches
          (
            home_team_id,
            away_team_id,
            home_score,
            away_score,
            match_date,
            status
          )
          VALUES
          ($1,$2,$3,$4,$5,$6)
          RETURNING *
        `,
        [
          homeTeamId,
          awayTeamId,
          Number(req.body.home_score) || 0,
          Number(req.body.away_score) || 0,
          req.body.match_date || new Date(),
          req.body.status || "scheduled"
        ]);

      res.json({
        ok:true,
        match:result.rows[0]
      });
    } catch(error){
      console.error("MATCH CREATE ERROR:",error);

      res.status(500).json({
        error:error.message
      });
    }
  }
);

app.put(
  "/api/matches/:id",
  requireAdmin,
  async(req,res)=>{
    try{
      const id=Number(req.params.id);

      const result =
        await pool.query(`
          UPDATE matches
          SET
            home_team_id=$1,
            away_team_id=$2,
            home_score=$3,
            away_score=$4,
            match_date=$5,
            status=$6
          WHERE id=$7
          RETURNING *
        `,
        [
          Number(req.body.home_team_id),
          Number(req.body.away_team_id),
          Number(req.body.home_score) || 0,
          Number(req.body.away_score) || 0,
          req.body.match_date || new Date(),
          req.body.status || "scheduled",
          id
        ]);

      if(!result.rows[0]){
        return res.status(404).json({
          error:"Match not found"
        });
      }

      res.json({
        ok:true,
        match:result.rows[0]
      });
    }catch(error){
      console.error("MATCH UPDATE ERROR:",error);

      res.status(500).json({
        error:error.message
      });
    }
  }
);

app.patch(
  "/api/matches/:id",
  requireAdmin,
  async(req,res)=>{
    try{
      const id=Number(req.params.id);

      const result =
        await pool.query(`
          UPDATE matches
          SET
            home_team_id=
              COALESCE($1,home_team_id),
            away_team_id=
              COALESCE($2,away_team_id),
            home_score=
              COALESCE($3,home_score),
            away_score=
              COALESCE($4,away_score),
            match_date=
              COALESCE($5,match_date),
            status=
              COALESCE($6,status)
          WHERE id=$7
          RETURNING *
        `,
        [
          req.body.home_team_id === undefined
            ? null
            : Number(req.body.home_team_id),

          req.body.away_team_id === undefined
            ? null
            : Number(req.body.away_team_id),

          req.body.home_score === undefined
            ? null
            : Number(req.body.home_score),

          req.body.away_score === undefined
            ? null
            : Number(req.body.away_score),

          req.body.match_date || null,

          req.body.status || null,

          id
        ]);

      if(!result.rows[0]){
        return res.status(404).json({
          error:"Match not found"
        });
      }

      res.json({
        ok:true,
        match:result.rows[0]
      });
    }catch(error){
      console.error("MATCH PATCH ERROR:",error);

      res.status(500).json({
        error:error.message
      });
    }
  }
);

app.delete(
  "/api/matches/:id",
  requireAdmin,
  async(req,res)=>{
    try{
      await pool.query(
        `
        DELETE FROM matches
        WHERE id=$1
        `,
        [Number(req.params.id)]
      );

      res.json({ok:true});
    }catch(error){
      console.error("MATCH DELETE ERROR:",error);

      res.status(500).json({
        error:error.message
      });
    }
  }
);

/* =========================================================
   MATCH EVENTS
========================================================= */

app.get(
  "/api/matches/:id/events",
  async(req,res)=>{
    try{
      const result =
        await pool.query(`
          SELECT
            e.id,
            e.match_id,
            e.player_id,
            p.name AS player_name,
            e.team_id,
            t.name AS team_name,
            e.type,
            e.minute,
            e.created_at
          FROM match_events e
          LEFT JOIN players p
            ON p.id=e.player_id
          LEFT JOIN teams t
            ON t.id=e.team_id
          WHERE e.match_id=$1
          ORDER BY
            e.minute ASC,
            e.id ASC
        `,
        [Number(req.params.id)]);

      res.json(result.rows);
    }catch(error){
      console.error("EVENTS GET ERROR:",error);

      res.status(500).json({
        error:error.message
      });
    }
  }
);

app.post(
  "/api/matches/:id/events",
  requireAdmin,
  async(req,res)=>{
    const client=await pool.connect();

    try{
      await client.query("BEGIN");

      const matchId=
        Number(req.params.id);

      const playerId=
        req.body.player_id
          ? Number(req.body.player_id)
          : null;

      const teamId=
        req.body.team_id
          ? Number(req.body.team_id)
          : null;

      const type=
        String(req.body.type || "")
          .trim()
          .toLowerCase();

      const minute=
        Number(req.body.minute) || 0;

      const allowed=[
        "goal",
        "yellow",
        "red",
        "assist",
        "save"
      ];

      if(!allowed.includes(type)){
        await client.query("ROLLBACK");

        return res.status(400).json({
          error:"Unknown event type"
        });
      }

      const event=
        await client.query(`
          INSERT INTO match_events
          (
            match_id,
            player_id,
            team_id,
            type,
            minute
          )
          VALUES
          ($1,$2,$3,$4,$5)
          RETURNING *
        `,
        [
          matchId,
          playerId,
          teamId,
          type,
          minute
        ]);

      if(playerId){

        if(type==="goal"){
          await client.query(`
            UPDATE players
            SET goals=
              COALESCE(goals,0)+1
            WHERE id=$1
          `,[playerId]);
        }

        if(type==="assist"){
          await client.query(`
            UPDATE players
            SET assists=
              COALESCE(assists,0)+1
            WHERE id=$1
          `,[playerId]);
        }

        if(type==="save"){
          await client.query(`
            UPDATE players
            SET saves=
              COALESCE(saves,0)+1
            WHERE id=$1
          `,[playerId]);
        }

        if(type==="yellow"){
          await client.query(`
            UPDATE players
            SET yellow_cards=
              COALESCE(yellow_cards,0)+1
            WHERE id=$1
          `,[playerId]);
        }

        if(type==="red"){
          await client.query(`
            UPDATE players
            SET red_cards=
              COALESCE(red_cards,0)+1
            WHERE id=$1
          `,[playerId]);
        }
      }

      await client.query("COMMIT");

      let title="AliScore";
      let message="Yeni hadisə";

      if(type==="goal"){
        title="⚽ QOL!";
        message="Yeni qol vuruldu";
      }

      if(type==="yellow"){
        title="🟨 Sarı kart";
        message="Oyunçu sarı kart aldı";
      }

      if(type==="red"){
        title="🟥 Qırmızı kart";
        message="Oyunçu qırmızı kart aldı";
      }

      if(type==="assist"){
        title="🅰️ Assist";
        message="Yeni assist";
      }

      if(type==="save"){
        title="🧤 Qurtarış";
        message="Qapıçı qurtarış etdi";
      }

      await createNotification(
        title,
        message,
        {
          type,
          matchId,
          playerId,
          teamId,
          minute
        }
      );

      res.json({
        ok:true,
        event:event.rows[0]
      });

    }catch(error){

      await client.query("ROLLBACK");

      console.error(
        "EVENT CREATE ERROR:",
        error
      );

      res.status(500).json({
        error:error.message
      });

    }finally{
      client.release();
    }
  }
);

/* =========================================================
   CARDS
========================================================= */

app.get(
  "/api/cards",
  async(req,res)=>{
    try{
      const result=
        await pool.query(`
          SELECT
            p.id,
            p.name,
            p.team_id,
            t.name AS team_name,
            COALESCE(
              p.yellow_cards,0
            ) AS yellow_cards,
            COALESCE(
              p.red_cards,0
            ) AS red_cards
          FROM players p
          LEFT JOIN teams t
            ON t.id=p.team_id
          ORDER BY
            red_cards DESC,
            yellow_cards DESC,
            p.name ASC
        `);

      res.json(result.rows);
    }catch(error){
      console.error(
        "CARDS GET ERROR:",
        error
      );

      res.status(500).json({
        error:error.message
      });
    }
  }
);

app.post(
  "/api/cards/change",
  requireAdmin,
  async(req,res)=>{
    try{
      const playerId=
        Number(req.body.player_id);

      const type=
        req.body.type;

      const delta=
        Number(req.body.delta) || 0;

      if(
        !playerId ||
        !["yellow","red"].includes(type)
      ){
        return res.status(400).json({
          error:"Invalid card data"
        });
      }

      const column=
        type==="yellow"
          ? "yellow_cards"
          : "red_cards";

      const result=
        await pool.query(
          `
          UPDATE players
          SET ${column} =
            GREATEST(
              0,
              COALESCE(
                ${column},0
              ) + $1
            )
          WHERE id=$2
          RETURNING *
          `,
          [
            delta,
            playerId
          ]
        );

      if(!result.rows[0]){
        return res.status(404).json({
          error:"Player not found"
        });
      }

      if(delta!==0){
        await createNotification(
          type==="yellow"
            ? "🟨 Sarı kart"
            : "🟥 Qırmızı kart",
          `${result.rows[0].name} üçün kart statistikası dəyişdi`,
          {
            type,
            playerId,
            delta
          }
        );
      }

      res.json({
        ok:true,
        player:result.rows[0]
      });

    }catch(error){
      console.error(
        "CARD CHANGE ERROR:",
        error
      );

      res.status(500).json({
        error:error.message
      });
    }
  }
);

/* =========================================================
   STATISTICS
========================================================= */

app.get(
  "/api/statistics",
  async(req,res)=>{
    try{
      const result=
        await pool.query(`
          SELECT
            p.id,
            p.name,
            p.team_id,
            t.name AS team_name,
            COALESCE(
              p.goals,0
            ) AS goals,
            COALESCE(
              p.assists,0
            ) AS assists,
            COALESCE(
              p.saves,0
            ) AS saves,
            COALESCE(
              p.yellow_cards,0
            ) AS yellow_cards,
            COALESCE(
              p.red_cards,0
            ) AS red_cards
          FROM players p
          LEFT JOIN teams t
            ON t.id=p.team_id
          ORDER BY
            goals DESC,
            assists DESC,
            p.name ASC
        `);

      res.json(result.rows);
    }catch(error){
      console.error(
        "STATS GET ERROR:",
        error
      );

      res.status(500).json({
        error:error.message
      });
    }
  }
);

app.post(
  "/api/statistics/change",
  requireAdmin,
  async(req,res)=>{
    try{
      const playerId=
        Number(req.body.player_id);

      const type=
        String(req.body.type || "");

      const delta=
        Number(req.body.delta) || 0;

      const columns={
        goals:"goals",
        assists:"assists",
        saves:"saves",
        yellow_cards:"yellow_cards",
        red_cards:"red_cards"
      };

      if(
        !playerId ||
        !columns[type]
      ){
        return res.status(400).json({
          error:"Invalid statistic"
        });
      }

      const column=
        columns[type];

      const result=
        await pool.query(
          `
          UPDATE players
          SET ${column} =
            GREATEST(
              0,
              COALESCE(
                ${column},0
              ) + $1
            )
          WHERE id=$2
          RETURNING *
          `,
          [
            delta,
            playerId
          ]
        );

      if(!result.rows[0]){
        return res.status(404).json({
          error:"Player not found"
        });
      }

      res.json({
        ok:true,
        player:result.rows[0]
      });

    }catch(error){
      console.error(
        "STAT CHANGE ERROR:",
        error
      );

      res.status(500).json({
        error:error.message
      });
    }
  }
);

/* =========================================================
   NOTIFICATIONS
========================================================= */

app.get(
  "/api/notifications",
  async(req,res)=>{
    try{
      const result=
        await pool.query(`
          SELECT
            id,
            title,
            message,
            created_at
          FROM notifications
          ORDER BY
            created_at DESC
          LIMIT 100
        `);

      res.json(result.rows);
    }catch(error){
      console.error(
        "NOTIFICATIONS ERROR:",
        error
      );

      res.status(500).json({
        error:error.message
      });
    }
  }
);

/* =========================================================
   TRANSFERS
========================================================= */

app.get(
  "/api/transfers",
  async(req,res)=>{
    try{
      const result=
        await pool.query(`
          SELECT
            tr.id,
            tr.player_id,
            p.name AS player_name,
            tr.from_team_id,
            ft.name AS from_team,
            tr.to_team_id,
            tt.name AS to_team,
            tr.created_at
          FROM transfers tr
          LEFT JOIN players p
            ON p.id=tr.player_id
          LEFT JOIN teams ft
            ON ft.id=tr.from_team_id
          LEFT JOIN teams tt
            ON tt.id=tr.to_team_id
          ORDER BY
            tr.created_at DESC
        `);

      res.json(result.rows);
    }catch(error){
      console.error(
        "TRANSFERS GET ERROR:",
        error
      );

      res.status(500).json({
        error:error.message
      });
    }
  }
);

app.post(
  "/api/transfers",
  requireAdmin,
  async(req,res)=>{
    const client=
      await pool.connect();

    try{
      await client.query(
        "BEGIN"
      );

      const playerId=
        Number(req.body.player_id);

      const toTeamId=
        Number(req.body.to_team_id);

      if(
        !playerId ||
        !toTeamId
      ){
        await client.query(
          "ROLLBACK"
        );

        return res.status(400).json({
          error:
            "Oyunçu və yeni komanda seçilməlidir"
        });
      }

      const playerResult=
        await client.query(
          `
          SELECT
            id,
            name,
            team_id
          FROM players
          WHERE id=$1
          FOR UPDATE
          `,
          [playerId]
        );

      if(!playerResult.rows[0]){
        await client.query(
          "ROLLBACK"
        );

        return res.status(404).json({
          error:
            "Player not found"
        });
      }

      const player=
        playerResult.rows[0];

      const fromTeamId=
        player.team_id;

      if(
        fromTeamId ===
        toTeamId
      ){
        await client.query(
          "ROLLBACK"
        );

        return res.status(400).json({
          error:
            "Oyunçu artıq bu komandadadır"
        });
      }

      await client.query(
        `
        UPDATE players
        SET team_id=$1
        WHERE id=$2
        `,
        [
          toTeamId,
          playerId
        ]
      );

      const transfer=
        await client.query(
          `
          INSERT INTO transfers
          (
            player_id,
            from_team_id,
            to_team_id
          )
          VALUES
          ($1,$2,$3)
          RETURNING *
          `,
          [
            playerId,
            fromTeamId,
            toTeamId
          ]
        );

      await client.query(
        "COMMIT"
      );

      const teams=
        await pool.query(
          `
          SELECT id,name
          FROM teams
          WHERE id = ANY($1::int[])
          `,
          [[
            fromTeamId,
            toTeamId
          ].filter(Boolean)]
        );

      let fromName=
        "Azad oyunçu";

      let toName=
        "Yeni komanda";

      for(
        const team
        of teams.rows
      ){
        if(
          team.id ===
          fromTeamId
        ){
          fromName=
            team.name;
        }

        if(
          team.id ===
          toTeamId
        ){
          toName=
            team.name;
        }
      }

      await createNotification(
        "🔄 Transfer",
        `${player.name}: ${fromName} → ${toName}`,
        {
          type:"transfer",
          playerId,
          fromTeamId,
          toTeamId
        }
      );

      res.json({
        ok:true,
        transfer:
          transfer.rows[0]
      });

    }catch(error){

      await client.query(
        "ROLLBACK"
      );

      console.error(
        "TRANSFER ERROR:",
        error
      );

      res.status(500).json({
        error:error.message
      });

    }finally{
      client.release();
    }
  }
);

/* =========================================================
   TEAM OF THE WEEK
========================================================= */

app.get(
  "/api/team-of-week",
  async(req,res)=>{
    try{
      const result=
        await pool.query(`
          SELECT
            tow.id,
            tow.week,
            tow.position,
            tow.player_id,
            p.name AS player_name,
            p.photo,
            p.number,
            t.name AS team_name
          FROM team_of_week tow
          JOIN players p
            ON p.id=tow.player_id
          LEFT JOIN teams t
            ON t.id=p.team_id
          ORDER BY
            tow.position,
            tow.id
        `);

      res.json(result.rows);
    }catch(error){
      console.error(
        "TEAM WEEK GET ERROR:",
        error
      );

      res.status(500).json({
        error:error.message
      });
    }
  }
);

app.post(
  "/api/team-of-week",
  requireAdmin,
  async(req,res)=>{
    const client=
      await pool.connect();

    try{
      await client.query(
        "BEGIN"
      );

      const week=
        String(
          req.body.week ||
          new Date()
            .toISOString()
            .slice(0,10)
        );

      const goalkeeper=
        Number(
          req.body.goalkeeper
        );

      const defenders=
        Array.isArray(
          req.body.defenders
        )
          ? req.body.defenders
              .map(Number)
              .filter(Boolean)
          : [];

      const midfielders=
        Array.isArray(
          req.body.midfielders
        )
          ? req.body.midfielders
              .map(Number)
              .filter(Boolean)
          : [];

      const attackers=
        Array.isArray(
          req.body.attackers
        )
          ? req.body.attackers
              .map(Number)
              .filter(Boolean)
          : [];

      const all=[
        goalkeeper,
        ...defenders,
        ...midfielders,
        ...attackers
      ].filter(Boolean);

      if(
        all.length !== 11
      ){
        await client.query(
          "ROLLBACK"
        );

        return res.status(400).json({
          error:
            "Komanda həftəsi üçün 11 oyunçu seçilməlidir"
        });
      }

      if(
        new Set(all).size !==
        11
      ){
        await client.query(
          "ROLLBACK"
        );

        return res.status(400).json({
          error:
            "Eyni oyunçu iki dəfə seçilə bilməz"
        });
      }

      if(
        defenders.length !== 3 &&
        defenders.length !== 4
      ){
        await client.query(
          "ROLLBACK"
        );

        return res.status(400).json({
          error:
            "Müdafiəçilər 3 və ya 4 olmalıdır"
        });
      }

      if(
        midfielders.length !== 3
      ){
        await client.query(
          "ROLLBACK"
        );

        return res.status(400).json({
          error:
            "Yarımmüdafiəçilər 3 olmalıdır"
        });
      }

      if(
        attackers.length !== 2 &&
        attackers.length !== 3
      ){
        await client.query(
          "ROLLBACK"
        );

        return res.status(400).json({
          error:
            "Hücumçular 2 və ya 3 olmalıdır"
        });
      }

      await client.query(
        `
        DELETE FROM team_of_week
        WHERE week=$1
        `,
        [week]
      );

      await client.query(
        `
        INSERT INTO team_of_week
        (
          week,
          player_id,
          position
        )
        VALUES
        ($1,$2,'Qapıçı')
        `,
        [
          week,
          goalkeeper
        ]
      );

      for(
        const playerId
        of defenders
      ){
        await client.query(
          `
          INSERT INTO team_of_week
          (
            week,
            player_id,
            position
          )
          VALUES
          ($1,$2,'Müdafiə')
          `,
          [
            week,
            playerId
          ]
        );
      }

      for(
        const playerId
        of midfielders
      ){
        await client.query(
          `
          INSERT INTO team_of_week
          (
            week,
            player_id,
            position
          )
          VALUES
          ($1,$2,'Yarımmüdafiə')
          `,
          [
            week,
            playerId
          ]
        );
      }

      for(
        const playerId
        of attackers
      ){
        await client.query(
          `
          INSERT INTO team_of_week
          (
            week,
            player_id,
            position
          )
          VALUES
          ($1,$2,'Hücum')
          `,
          [
            week,
            playerId
          ]
        );
      }

      await client.query(
        "COMMIT"
      );

      await createNotification(
        "⭐ Komanda həftəsi",
        `Yeni Komanda həftəsi seçildi: ${week}`,
        {
          type:"team_of_week",
          week
        }
      );

      res.json({
        ok:true,
        week
      });

    }catch(error){

      await client.query(
        "ROLLBACK"
      );

      console.error(
        "TEAM WEEK ERROR:",
        error
      );

      res.status(500).json({
        error:error.message
      });

    }finally{
      client.release();
    }
  }
);

/* =========================================================
   LINEUPS
========================================================= */

app.get(
  "/api/lineups/:matchId",
  async(req,res)=>{
    try{
      const result=
        await pool.query(`
          SELECT
            l.id,
            l.match_id,
            l.player_id,
            l.position,
            p.name AS player_name,
            p.number,
            p.photo,
            p.team_id
          FROM lineups l
          JOIN players p
            ON p.id=l.player_id
          WHERE l.match_id=$1
          ORDER BY l.id
        `,
        [
          Number(
            req.params.matchId
          )
        ]);

      res.json(result.rows);
    }catch(error){
      console.error(
        "LINEUPS GET ERROR:",
        error
      );

      res.status(500).json({
        error:error.message
      });
    }
  }
);

app.post(
  "/api/lineups",
  requireAdmin,
  async(req,res)=>{
    try{
      const matchId=
        Number(req.body.match_id);

      const playerId=
        Number(req.body.player_id);

      const position=
        String(
          req.body.position || ""
        ).trim();

      if(
        !matchId ||
        !playerId ||
        !position
      ){
        return res.status(400).json({
          error:
            "Lineup məlumatı tam deyil"
        });
      }

      const result=
        await pool.query(`
          INSERT INTO lineups
          (
            match_id,
            player_id,
            position
          )
          VALUES
          ($1,$2,$3)
          ON CONFLICT
          (match_id,player_id)
          DO UPDATE SET
            position=EXCLUDED.position
          RETURNING *
        `,
        [
          matchId,
          playerId,
          position
        ]);

      res.json({
        ok:true,
        lineup:
          result.rows[0]
      });

    }catch(error){
      console.error(
        "LINEUP CREATE ERROR:",
        error
      );

      res.status(500).json({
        error:error.message
      });
    }
  }
);

app.delete(
  "/api/lineups/:id",
  requireAdmin,
  async(req,res)=>{
    try{
      await pool.query(
        `
        DELETE FROM lineups
        WHERE id=$1
        `,
        [
          Number(
            req.params.id
          )
        ]
      );

      res.json({
        ok:true
      });
    }catch(error){
      console.error(
        "LINEUP DELETE ERROR:",
        error
      );

      res.status(500).json({
        error:error.message
      });
    }
  }
);

/* =========================================================
   REAL PUSH API
========================================================= */

app.get(
  "/api/push/public-key",
  (req,res)=>{
    res.json({
      ok:true,
      enabled:PUSH_ENABLED,
      publicKey:
        VAPID_PUBLIC_KEY
    });
  }
);

app.post(
  "/api/push/subscribe",
  async(req,res)=>{
    try{
      const subscription=
        req.body;

      if(
        !subscription ||
        !subscription.endpoint ||
        !subscription.keys
      ){
        return res.status(400).json({
          ok:false,
          error:
            "Invalid push subscription"
        });
      }

      await pool.query(
        `
        INSERT INTO push_subscriptions
        (
          endpoint,
          subscription
        )
        VALUES
        ($1,$2)
        ON CONFLICT(endpoint)
        DO UPDATE SET
          subscription=EXCLUDED.subscription
        `,
        [
          subscription.endpoint,
          JSON.stringify(
            subscription
          )
        ]
      );

      console.log(
        "Push subscription saved"
      );

      res.json({
        ok:true
      });

    }catch(error){
      console.error(
        "PUSH SUBSCRIBE ERROR:",
        error
      );

      res.status(500).json({
        ok:false,
        error:error.message
      });
    }
  }
);

app.post(
  "/api/push/test",
  requireAdmin,
  async(req,res)=>{
    try{
      await createNotification(
        "🔔 AliScore",
        "Push bildirişləri işləyir!",
        {
          type:"test"
        }
      );

      res.json({
        ok:true,
        message:
          "Test push sent"
      });

    }catch(error){
      console.error(
        "PUSH TEST ERROR:",
        error
      );

      res.status(500).json({
        ok:false,
        error:error.message
      });
    }
  }
);

/* =========================================================
   SERVICE WORKER
========================================================= */

app.get(
  "/service-worker.js",
  (req,res)=>{
    res.type(
      "application/javascript"
    );

    res.send(`
self.addEventListener(
  "install",
  event => {
    self.skipWaiting();
  }
);

self.addEventListener(
  "activate",
  event => {
    event.waitUntil(
      self.clients.claim()
    );
  }
);

self.addEventListener(
  "push",
  event => {

    let data = {
      title: "AliScore",
      message: "Yeni bildiriş"
    };

    try {
      if(event.data){
        data =
          event.data.json();
      }
    } catch(e) {
      try {
        data.message =
          event.data.text();
      } catch(err) {}
    }

    const title =
      data.title ||
      "AliScore";

    const options = {
      body:
        data.message ||
        "Yeni bildiriş",
      icon:
        "/icon-192.png",
      badge:
        "/icon-192.png",
      data:
        data.data || {},
      vibrate: [
        200,
        100,
        200
      ],
      requireInteraction:
        false
    };

    event.waitUntil(
      self.registration
        .showNotification(
          title,
          options
        )
    );
  }
);

self.addEventListener(
  "notificationclick",
  event => {

    event.notification.close();

    event.waitUntil(
      clients.matchAll({
        type:"window",
        includeUncontrolled:true
      }).then(
        clientList => {

          for(
            const client
            of clientList
          ){
            if(
              "focus" in client
            ){
              return client.focus();
            }
          }

          if(
            clients.openWindow
          ){
            return clients.openWindow(
              "/"
            );
          }
        }
      )
    );
  }
);
`);
  }
);

/* =========================================================
   STATIC FILES
========================================================= */

app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);

/* =========================================================
   FRONTEND
========================================================= */

app.get(
  "*",
  (req,res)=>{
    res.sendFile(
      path.join(
        __dirname,
        "public",
        "index.html"
      )
    );
  }
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (
    err,
    req,
    res,
    next
  )=>{
    console.error(
      "UNHANDLED ERROR:",
      err
    );

    res.status(500).json({
      ok:false,
      error:
        err.message ||
        "Server error"
    });
  }
);

/* =========================================================
   START SERVER
========================================================= */

async function start(){

  try{

    await initDatabase();

    app.listen(
      PORT,
      "0.0.0.0",
      ()=>{
        console.log(
          `AliScore running on port ${PORT}`
        );

        console.log(
          `Push enabled: ${PUSH_ENABLED}`
        );
      }
    );

  }catch(error){

    console.error(
      "STARTUP ERROR:",
      error
    );

    process.exit(1);
  }
}

start();
