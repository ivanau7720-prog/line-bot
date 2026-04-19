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
  const { data } = await supabase
    .from("players")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (!data) {
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
  if (GAME.roundActive) return res.json({ msg: "已在进行中" });

  const { data } = await supabase
    .from("rounds")
    .insert([{ status: "betting" }])
    .select()
    .single();

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

  res.json({ msg: "开局成功" });
});

// ===== 下注 =====
app.post("/bet", async (req, res) => {
  const { userId, side, amount } = req.body;

  if (!GAME.isBetting) {
    return res.json({ success: false, msg: "已停止下注" });
  }

  if (!["B", "P", "T"].includes(side)) {
    return res.json({ success: false, msg: "下注错误" });
  }

  const user = await getUser(userId);

  if (user.balance < amount) {
    return res.json({ success: false, msg: "余额不足" });
  }

  await changeBalance(userId, -amount);

  await supabase.from("transactions").insert([
    {
      user_id: userId,
      amount,
      bet_side: side,
      round_id: GAME.currentRoundId
    }
  ]);

  res.json({ success: true, msg: "下注成功" });
});

// ===== 结算 =====
app.post("/result", async (req, res) => {
  const { result } = req.body;

  if (!GAME.roundActive) {
    return res.json({ msg: "没有进行中的局" });
  }

  const { data: bets } = await supabase
    .from("transactions")
    .select("*")
    .eq("round_id", GAME.currentRoundId);

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

  res.json({ msg: "结算完成：" + result });
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

  res.json(data);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("RUNNING"));
