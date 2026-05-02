const express = require("express");
const { createClient } = require("@supabase/supabase-js");


const app = express();
app.use(express.json());
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/login.html");
});
app.use(express.static("public"));


// ===== DB =====
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);
// ===== 初始化玩家字段 =====
async function initDB(){

try{

await supabase.rpc("exec_sql", {
sql: `
ALTER TABLE players
ADD COLUMN IF NOT EXISTS username TEXT UNIQUE;

ALTER TABLE players
ADD COLUMN IF NOT EXISTS password TEXT;
`
});

}catch(err){
console.log("DB init skip");
}

}

initDB();
// ===== 游戏状态 =====
let GAME = {
  isBetting: false,
  roundActive: false,
  bets: {},
  timer: null,
  timeLeft: 60
};

let playersCache = {};
let betCooldown = {};

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

    let newBalance = Number(data.balance) + Number(amount);

if (newBalance < 0) newBalance = 0;

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
    GAME.currentRound = (GAME.currentRound || 0) + 1;
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

    const betAmount = Number(amount);

    if (!GAME.isBetting) {
      return res.json({
        success:false,
        msg:"已停止下注"
      });
    }

    if (!["B","P","T"].includes(side)) {
      return res.json({
        success:false,
        msg:"下注区域错误"
      });
    }

    if (betAmount < 50 || betAmount > 50000) {
      return res.json({
        success:false,
        msg:"下注范围 50 - 50000"
      });
    }

    const now = Date.now();

    if (
      betCooldown[userId] &&
      now - betCooldown[userId] < 3000
    ) {
      return res.json({
        success:false,
        msg:"请3秒后再下注"
      });
    }

    betCooldown[userId] = now;

    const user = await getUser(userId);

    if (!user) {
      return res.json({
        success:false
      });
    }

    if (Number(user.balance) < betAmount) {
      return res.json({
        success:false,
        msg:"余额不足"
      });
    }

    await changeBalance(userId, -betAmount);

    if (GAME.bets[userId]) {

      GAME.bets[userId].amount += betAmount;
      GAME.bets[userId].side = side;

    } else {

      GAME.bets[userId] = {
        side: side,
        amount: betAmount
      };

    }

    res.json({
      success:true
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      success:false
    });
  }
});

// ===== 结算 =====
app.post("/result", async (req, res) => {
  try { 
   const { result } = req.body;
    
    if (!GAME.roundActive) {
  return res.json({ msg: "没有进行中的局" });
}

// 先锁局，防重复开奖
GAME.roundActive = false;
GAME.isBetting = false;
// 👉 写入局记录（现在位置正确）
const { data: roundData } = await supabase
  .from("rounds")
  .insert([
    {
      result: result,
      status: "done"
    }
  ])
  .select()
  .single();

const roundId = roundData.id;
    for (const uid in GAME.bets) {
      const bet = GAME.bets[uid];

      const { data } = await supabase
        .from("players")
        .select("*")
        .eq("user_id", uid)
        .single();

      if (!data) continue;

      let balance = Number(data.balance);
      let win = Number(data.total_win || 0);
      let lose = Number(data.total_lose || 0);

      // 🎯 赢
      let payout = 0;

if (bet.side === result) {

  payout = bet.amount * 2;

  // 庄抽水5%
  if (result === "B") {
    payout = bet.amount * 1.95;
  }

  // 和局8倍
  if (result === "T") {
    payout = bet.amount * 8;
  }

  balance += payout;
  win += bet.amount;

} else {

  lose += bet.amount;

}

      await supabase
  .from("players")
  .update({
    balance,
    total_win: win,
    total_lose: lose
  })
  .eq("user_id", uid);

// 👇👇👇 新加这里（很关键）
await supabase.from("transactions").insert([
  {
    user_id: uid,
    amount: bet.amount,
    bet_side: bet.side,
    result: result,
    win_amount: bet.side === result ? payout : 0,
    type: bet.side === result ? "win" : "lose",
    round_id: roundId
  }
]);
}      
 
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
  total: GAME.bets,
  round: GAME.currentRound || 0
});
});

// ===== 获取余额 =====
app.get("/balance/:userId", async (req, res) => {
  const { userId } = req.params;

  try {
    const { data } = await supabase
      .from("players")
      .select("*")
      .eq("user_id", userId)
      .single();

    res.json({ balance: data?.balance || 0 });

  } catch (err) {
    console.error(err);
    res.json({ balance: 0 });
  }
});

// ===== 管理员：玩家列表 =====
app.get("/admin/players", async (req, res) => {
  try {
    const { data } = await supabase
      .from("players")
      .select("*");

    const list = data.map(p => ({
      id: p.user_id,
      balance: p.balance,
      win: p.total_win || 0,
      lose: p.total_lose || 0
      
    }));

    res.json(list);

  } catch (err) {
    console.error(err);
    res.json([]);
  }
});

// ===== 管理员：局记录 =====
app.get("/admin/rounds", async (req, res) => {
  const { data } = await supabase
    .from("rounds")
    .select("*")
    .order("id", { ascending: false })
    .limit(20);

  res.json(data || []);
});

// ===== 管理员：交易记录 =====
app.get("/admin/transactions", async (req, res) => {
  const { data } = await supabase
    .from("transactions")
    .select("*")
    .order("id", { ascending: false })
    .limit(50);

  res.json(data || []);
});

// ===== 盈利统计 =====
app.get("/admin/bets", async (req,res)=>{

try{

let list = [];

for(const uid in GAME.bets){

const bet = GAME.bets[uid];

const user = await getUser(uid);

list.push({
userId: uid,
name: user?.name || "玩家",
side: bet.side,
amount: bet.amount
});

}

res.json(list);

}catch(err){
console.error(err);
res.json([]);
}

});

app.get("/admin/profit", async (req, res) => {
  try {
    const { data } = await supabase
      .from("transactions")
      .select("*");

    let total = 0;
    let today = 0;

    const now = new Date().toDateString();

    data.forEach(t => {
      const profit = t.type === "lose"
        ? t.amount
        : -t.win_amount;

      total += profit;

      const d = new Date(t.created_at).toDateString();
      if (d === now) {
        today += profit;
      }
    });

    res.json({
      total,
      today
    });

  } catch (err) {
    console.error(err);
    res.json({ total:0, today:0 });
  }
});
// ===== 管理员：加钱 =====
app.post("/admin/add", async (req, res) => {
  try {
    const { userId, amount } = req.body;

    await changeBalance(userId, amount);

await supabase.from("transactions").insert([
{
  user_id: userId,
  amount: Number(amount),
  type: "admin_add"
}
]);

res.json({ success: true });

  } catch (err) {
    console.error(err);
    res.json({ success: false });
  }
});

// ===== 管理员：扣钱 =====
app.post("/admin/minus", async (req, res) => {
  try {
    const { userId, amount } = req.body;

    await changeBalance(userId, -amount);

await supabase.from("transactions").insert([
{
  user_id: userId,
  amount: Number(amount),
  type: "admin_minus"
}
]);

res.json({ success: true });

  } catch (err) {
    console.error(err);
    res.json({ success: false });
  }
});

// ===== 注册 =====
app.post("/register", async (req,res)=>{

const { username, password } = req.body;

if(!/^[a-zA-Z0-9]{4,12}$/.test(username)){
return res.json({success:false,msg:"ID限英文数字4-12"});
}

if(!password || password.length < 4){
return res.json({success:false,msg:"密码至少4位"});
}

const { data: old } = await supabase
.from("players")
.select("*")
.eq("username", username)
.maybeSingle();

if(old){
return res.json({success:false,msg:"ID已存在"});
}

const userId = "P" + Date.now();

await supabase.from("players").insert([{
user_id:userId,
username,
password,
name:username,
balance:1000
}]);

res.json({success:true});

});

// ===== 登录 =====
app.post("/member-login", async (req,res)=>{

const { username,password } = req.body;

const { data } = await supabase
.from("players")
.select("*")
.eq("username",username)
.eq("password",password)
.maybeSingle();

if(!data){
return res.json({success:false,msg:"账号或密码错误"});
}

res.json({
success:true,
userId:data.user_id,
name:data.username
});

});
// ===== 启动 =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("RUNNING ON", PORT);
});
