const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());
app.use(express.static("public"));

// ===== 环境检查 =====
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error("❌ 缺少 SUPABASE 环境变量");
  process.exit(1);
}

// ===== DB =====
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ===== 游戏状态 =====
let GAME = {
  isBetting: false,
  roundActive: false,
  bets: {},
  timer: null,
  timeLeft: 60
};

// ===== 获取用户 =====
async function getUser(userId) {
  try {
    const { data } = await supabase
      .from("players")
      .select("*")
      .eq("user_id", userId)
      .single();

    if (!data) {
      const newUser = {
        user_id: userId,
        balance: 1000,
        name: "玩家"
      };
      await supabase.from("players").insert([newUser]);
      return newUser;
    }

    return data;
  } catch (err) {
    console.error("getUser error:", err);
    return null;
  }
}

// ===== 改余额 =====
async function changeBalance(userId, amount) {
  try {
    const { data } = await supabase
      .from("players")
      .select("*")
      .eq("user_id", userId)
      .single();

    const newBalance = Number(data.balance) + Number(amount);

    await supabase
      .from("players")
      .update({ balance: newBalance })
      .eq("user_id", userId);
  } catch (err) {
    console.error("changeBalance error:", err);
  }
}

// ===== 开局 =====
app.post("/start", (req, res) => {
  try {
    if (GAME.roundActive) return res.json({ msg: "已在进行中" });

    GAME.roundActive = true;
    GAME.isBetting = true;
    GAME.bets = {};
    GAME.timeLeft = 60;

    GAME.timer = setInterval(() => {
      GAME.timeLeft -= 1;

      if (GAME.timeLeft <= 0) {
        GAME.isBetting = false;
        clearInterval(GAME.timer);
      }
    }, 1000);

    res.json({ msg: "开局成功" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "错误" });
  }
});

// ===== 下注 =====
app.post("/bet", async (req, res) => {
  try {
    const { userId, side, amount } = req.body;

    if (!GAME.isBetting) {
      return res.json({ success: false, msg: "已停止下注" });
    }

    if (!["B", "P", "T"].includes(side)) {
      return res.json({ success: false });
    }

    const user = await getUser(userId);
    if (!user) return res.json({ success: false });

    if (user.balance < amount) {
      return res.json({ success: false, msg: "余额不足" });
    }

    await changeBalance(userId, -amount);

    GAME.bets[userId] = { side, amount };

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

// ===== 结算 =====
app.post("/result", async (req, res) => {
  try {
    const { result } = req.body;

    if (!GAME.roundActive) return res.json({ msg: "没有进行中的局" });

    for (const uid in GAME.bets) {
      const bet = GAME.bets[uid];

      if (bet.side === result) {
        await changeBalance(uid, bet.amount * 2);
      }
    }

    GAME.roundActive = false;
    GAME.isBetting = false;
    GAME.bets = {};

    res.json({ msg: "结算完成" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "错误" });
  }
});

// ===== 状态 =====
app.get("/state", (req, res) => {
  res.json({
    isBetting: GAME.isBetting,
    timeLeft: GAME.timeLeft,
    total: GAME.bets
  });
});

// ===== 启动 =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("RUNNING ON", PORT);
});
