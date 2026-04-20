const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());
app.use(express.static("public"));

// ===== Supabase =====
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ===== 游戏状态 ===== 
let GAME = {
  isBetting: false,
  roundActive: false,
  timer: null,
  timeLeft: 60,
  currentRoundId: null
};

// ===== 获取用户 =====
async function getUser(userId) {
  const { data, error } = await supabase
    .from("players")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (error || !data) {
    const newUser = {
      user_id: userId,
      balance: 1000
    };

    await supabase.from("players").insert([newUser]);
    return newUser;
  }

  return data;
}

// ===== 修改余额 =====
async function changeBalance(userId, amount) {
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
}

// ===== 开局 =====
app.post("/start", async (req, res) => {
  try {
    if (GAME.roundActive) {
      return res.json({ msg: "⚠️ 已在进行中" });
    }

    const { data, error } = await supabase
      .from("rounds")
      .insert([{ status: "betting" }])
      .select()
      .single();

    if (error) {
      console.log(error);
      return res.json({ msg: "❌ 开局失败" });
    }

    GAME.currentRoundId = data.id;
    GAME.roundActive = true;
    GAME.isBetting = true;
    GAME.timeLeft = 60;

    GAME.timer = setInterval(() => {
      GAME.timeLeft -= 1;

      if (GAME.timeLeft <= 0) {
        GAME.isBetting = false;
        clearInterval(GAME.timer);
      }
    }, 1000);

    res.json({ msg: "✅ 开局成功" });

  } catch (err) {
    console.log(err);
    res.json({ msg: "❌ 系统错误" });
  }
});

// ===== 下注 =====
app.post("/bet", async (req, res) => {
  try {
    const { userId, side, amount } = req.body;

    if (!GAME.isBetting) {
      return res.json({ success: false, msg: "❌ 已停止下注" });
    }

    if (!["B", "P", "T"].includes(side)) {
      return res.json({ success: false, msg: "❌ 下注错误" });
    }

    const user = await getUser(userId);

    if (user.balance < amount) {
      return res.json({ success: false, msg: "❌ 余额不足" });
    }

    await changeBalance(userId, -amount);

    const { error } = await supabase.from("transactions").insert([
      {
        user_id: userId,
        amount,
        bet_side: side,
        round_id: GAME.currentRoundId
      }
    ]);

    if (error) {
      console.log(error);
      return res.json({ msg: "❌ 下注失败(DB错误)" });
    }

    res.json({ success: true, msg: "✅ 下注成功" });

  } catch (err) {
    console.log(err);
    res.json({ msg: "❌ 系统错误" });
  }
});

// ===== 结算 =====
app.post("/result", async (req, res) => {
  try {
    const { result } = req.body;

    if (!GAME.roundActive) {
      return res.json({ msg: "❌ 没有进行中的局" });
    }

    const { data: bets, error } = await supabase
      .from("transactions")
      .select("*")
      .eq("round_id", GAME.currentRoundId);

    if (error) {
      console.log(error);
      return res.json({ msg: "❌ 获取下注失败" });
    }

    if (!bets || bets.length === 0) {
      return res.json({ msg: "⚠️ 没有下注记录" });
    }

    for (const bet of bets) {
      if (bet.bet_side === result) {
        await changeBalance(bet.user_id, bet.amount * 2);
      }
    }

    await supabase
      .from("rounds")
      .update({ result, status: "done" })
      .eq("id", GAME.currentRoundId);

    GAME.roundActive = false;
    GAME.isBetting = false;
    GAME.currentRoundId = null;

    res.json({ msg: "🎉 结算完成：" + result });

  } catch (err) {
    console.log(err);
    res.json({ msg: "❌ 结算失败" });
  }
});

// ===== 状态 =====
app.get("/state", (req, res) => {
  res.json({
    isBetting: GAME.isBetting,
    timeLeft: GAME.timeLeft
  });
});

// ===== 历史 =====
app.get("/history", async (req, res) => {
  const { data } = await supabase
    .from("rounds")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(20);

  res.json(data || []);
});

// ===== 🆕 查询余额 =====
app.get("/balance/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;

    const { data } = await supabase
      .from("players")
      .select("balance")
      .eq("user_id", userId)
      .single();

    res.json({ balance: data?.balance || 0 });

  } catch (err) {
    console.log(err);
    res.json({ balance: 0 });
  }
});

// ===== 🆕 下注统计 =====
app.get("/stats", async (req, res) => {
  try {
    if (!GAME.currentRoundId) {
      return res.json({ B: 0, P: 0, T: 0 });
    }

    const { data } = await supabase
      .from("transactions")
      .select("bet_side, amount")
      .eq("round_id", GAME.currentRoundId);

    let stats = { B: 0, P: 0, T: 0 };

    data.forEach(b => {
      stats[b.bet_side] += b.amount;
    });

    res.json(stats);

  } catch (err) {
    console.log(err);
    res.json({ B: 0, P: 0, T: 0 });
  }
});

// ===== 启动 =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 RUNNING ON " + PORT));
