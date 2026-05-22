const express = require("express");
const { createClient } = require("@supabase/supabase-js");


const app = express();
app.use(express.json());
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin888";
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/login.html");
});

app.get("/admin.html", (req, res) => {
  res.redirect("/admin-login.html");
});

app.use(express.static("public"));
// ===== 管理员登录检查 =====
function checkAdmin(req, res, next){

  const token = req.headers["x-admin-token"];

  if(token !== ADMIN_PASSWORD){

    return res.status(403).json({
      success:false,
      msg:"Admin forbidden"
    });

  }

  next();
}

// ===== 管理员登录 =====
app.post("/admin-login", (req, res) => {

  const { password } = req.body;

  if(password === ADMIN_PASSWORD){

    return res.json({
      success:true,
      token: ADMIN_PASSWORD
    });

  }

  res.json({
    success:false,
    msg:"密码错误"
  });

});

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

ALTER TABLE players
ADD COLUMN IF NOT EXISTS agent_code TEXT;
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
  timeLeft: 50
};

let playersCache = {};
let betCooldown = {};
let rechargeCooldown = {};
let withdrawCooldown = {};
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
  balance: 0,
  name: userId
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
    GAME.timeLeft = 50;

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
await supabase.from("turnover_records").insert([
  {
    user_id: userId,
    agent_code: user.agent_code || null,
    amount: betAmount,
    bet_side: side,
    type: "bet"
  }
]);
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
app.post("/result", checkAdmin, async (req, res) => {
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

// ===== 前台：开奖记录 / 路单 =====
app.get("/history", async (req, res) => {
  try {
    const { data } = await supabase
      .from("rounds")
      .select("*")
      .eq("status", "done")
      .order("id", { ascending: false })
      .limit(50);

    res.json((data || []).reverse());

  } catch (err) {
    console.error("history error:", err);
    res.json([]);
  }
});

// ===== 前台：庄闲和统计 =====
app.get("/stats", async (req, res) => {
  try {
    const { data } = await supabase
      .from("rounds")
      .select("result")
      .eq("status", "done")
      .order("id", { ascending: false })
      .limit(100);

    let stats = {
      B: 0,
      P: 0,
      T: 0
    };

    (data || []).forEach(r => {
      if (r.result === "B") stats.B++;
      if (r.result === "P") stats.P++;
      if (r.result === "T") stats.T++;
    });

    res.json(stats);

  } catch (err) {
    console.error("stats error:", err);
    res.json({
      B: 0,
      P: 0,
      T: 0
    });
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

   res.json({
  balance: data?.balance || 0,
  total_topup: data?.total_topup || 0
});

  } catch (err) {
    console.error(err);
res.json({
  balance: 0,
  total_topup: 0
});
}
});    

// ===== 管理员：新增代理 =====
app.post("/admin/create-agent", checkAdmin, async (req, res) => {
  try {
    const { agentCode, agentName } = req.body;

    if (!agentCode || !agentName) {
      return res.json({ success:false, msg:"资料不完整" });
    }

    await supabase.from("agents").insert([
      {
        agent_code: agentCode,
        agent_name: agentName
      }
    ]);

    res.json({ success:true });

  } catch (err) {
    console.error(err);
    res.json({ success:false });
  }
});

// ===== 管理员：代理列表 + 流水 =====
app.get("/admin/agents", checkAdmin, async (req, res) => {
  try {
    const { data: agents } = await supabase
      .from("agents")
      .select("*");

    let list = [];

    for (const a of agents || []) {
      const { data: players } = await supabase
        .from("players")
        .select("*")
        .eq("agent_code", a.agent_code);

      const { data: turnover } = await supabase
        .from("turnover_records")
        .select("*")
        .eq("agent_code", a.agent_code);

      let totalTurnover = 0;

      (turnover || []).forEach(t => {
        totalTurnover += Number(t.amount || 0);
      });

      list.push({
        agent_code: a.agent_code,
        agent_name: a.agent_name,
        player_count: players ? players.length : 0,
        total_turnover: totalTurnover
      });
    }

    res.json(list);

  } catch (err) {
    console.error(err);
    res.json([]);
  }
});

// ===== 管理员：玩家列表 =====
app.get("/admin/players", checkAdmin, async (req, res) => {
  try {
    const { data } = await supabase
      .from("players")
      .select("*");

   const list = data.map(p => ({
  id: p.user_id,
  username: p.username || "",
  agent_code: p.agent_code || "-",
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
app.get("/admin/rounds", checkAdmin, async (req, res) => {
  const { data } = await supabase
    .from("rounds")
    .select("*")
    .order("id", { ascending: false })
    .limit(20);

  res.json(data || []);
});

// ===== 管理员：玩家流水记录 + 筛选 =====
app.get("/admin/transactions", checkAdmin, async (req, res) => {
  try {
    const { userId, agentCode, date } = req.query;

    let query = supabase
      .from("transactions")
      .select("*")
      .order("id", { ascending: false })
      .limit(100);

    if (userId) {
      query = query.eq("user_id", userId);
    }

    if (date) {
      const start = date + "T00:00:00";
      const end = date + "T23:59:59";
      query = query.gte("created_at", start).lte("created_at", end);
    }

    const { data: tx } = await query;

    const { data: players } = await supabase
      .from("players")
      .select("*");

    let list = (tx || []).map(t => {
      const player = (players || []).find(p => p.user_id === t.user_id);

      return {
        user_id: t.user_id,
        username: player?.username || player?.name || "-",
        agent_code: player?.agent_code || "-",
        bet_side: t.bet_side || "-",
        amount: t.amount || 0,
        type: t.type || "-",
        result: t.result || "-",
        win_amount: t.win_amount || 0,
        created_at: t.created_at || ""
      };
    });

    if (agentCode) {
      list = list.filter(t => t.agent_code === agentCode);
    }

    res.json(list);

  } catch (err) {
    console.error(err);
    res.json([]);
  }
});


// ===== 盈利统计 =====
app.get("/admin/bets", checkAdmin, async (req,res)=>{

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

app.get("/admin/profit", checkAdmin, async (req, res) => {
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
app.post("/admin/add", checkAdmin, async (req, res) => {
  try {
    const { userId, amount } = req.body;

    const addMoney = Number(amount);

/* 先查玩家资料 */
const { data } = await supabase
  .from("players")
  .select("*")
  .eq("user_id", userId)
  .single();

let newBalance = Number(data.balance || 0) + addMoney;
let newTopup = Number(data.total_topup || 0) + addMoney;

/* 更新余额 + 累计充值 */
await supabase
  .from("players")
  .update({
    balance: newBalance,
    total_topup: newTopup
  })
  .eq("user_id", userId);

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
app.post("/admin/minus", checkAdmin, async (req, res) => {
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

const { username, password, agentCode } = req.body;

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
  balance:1000,
  agent_code: agentCode || null
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
// ===== 管理员：查看充值申请 =====
app.get("/admin/recharge-requests", checkAdmin, async (req, res) => {
  try {
    const { data } = await supabase
      .from("recharge_requests")
      .select("*")
      .order("created_at", { ascending: false });

    res.json(data || []);
  } catch (err) {
    console.error(err);
    res.json([]);
  }
});


// ===== 管理员：查看提款申请 =====
app.get("/admin/withdraw-requests", checkAdmin, async (req, res) => {
  try {
    const { data } = await supabase
      .from("withdraw_requests")
      .select("*")
      .order("created_at", { ascending: false });

    res.json(data || []);
  } catch (err) {
    console.error(err);
    res.json([]);
  }
});

// ===== 管理员：批准充值 =====
app.post("/admin/approve-recharge", checkAdmin, async (req, res) => {
  try {
    const { id } = req.body;

    const { data: request } = await supabase
      .from("recharge_requests")
      .select("*")
      .eq("id", id)
      .single();

    if (!request || request.status !== "pending") {
      return res.json({ success:false, msg:"申请不存在或已处理" });
    }

    const { data: player } = await supabase
      .from("players")
      .select("*")
      .eq("user_id", request.user_id)
      .single();

    const newBalance = Number(player.balance || 0) + Number(request.amount);
    const newTopup = Number(player.total_topup || 0) + Number(request.amount);

    await supabase
      .from("players")
      .update({
        balance: newBalance,
        total_topup: newTopup
      })
      .eq("user_id", request.user_id);

    await supabase
      .from("recharge_requests")
      .update({ status:"approved" })
      .eq("id", id);

    await supabase.from("transactions").insert([{
      user_id: request.user_id,
      amount: Number(request.amount),
      type: "recharge_approved"
    }]);

    res.json({ success:true });

  } catch (err) {
    console.error(err);
    res.json({ success:false });
  }
});


// ===== 管理员：拒绝充值 =====
app.post("/admin/reject-recharge", checkAdmin, async (req, res) => {
  try {
    const { id } = req.body;

    await supabase
      .from("recharge_requests")
      .update({ status:"rejected" })
      .eq("id", id);

    res.json({ success:true });

  } catch (err) {
    console.error(err);
    res.json({ success:false });
  }
});


// ===== 管理员：批准提款 =====
app.post("/admin/approve-withdraw", checkAdmin, async (req, res) => {
  try {
    const { id } = req.body;

    const { data: request } = await supabase
      .from("withdraw_requests")
      .select("*")
      .eq("id", id)
      .single();

    if (!request || request.status !== "pending") {
      return res.json({ success:false, msg:"申请不存在或已处理" });
    }

    const { data: player } = await supabase
      .from("players")
      .select("*")
      .eq("user_id", request.user_id)
      .single();

    if (Number(player.balance || 0) < Number(request.amount)) {
      return res.json({ success:false, msg:"玩家余额不足" });
    }

    const newBalance = Number(player.balance || 0) - Number(request.amount);

    await supabase
      .from("players")
      .update({ balance: newBalance })
      .eq("user_id", request.user_id);

    await supabase
      .from("withdraw_requests")
      .update({ status:"approved" })
      .eq("id", id);

    await supabase.from("transactions").insert([{
      user_id: request.user_id,
      amount: Number(request.amount),
      type: "withdraw_approved"
    }]);

    res.json({ success:true });

  } catch (err) {
    console.error(err);
    res.json({ success:false });
  }
});


// ===== 管理员：拒绝提款 =====
app.post("/admin/reject-withdraw", checkAdmin, async (req, res) => {
  try {
    const { id } = req.body;

    await supabase
      .from("withdraw_requests")
      .update({ status:"rejected" })
      .eq("id", id);

    res.json({ success:true });

  } catch (err) {
    console.error(err);
    res.json({ success:false });
  }
});

// ===== 玩家：我的充值记录 =====
app.get("/my-recharge-requests/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    const { data } = await supabase
      .from("recharge_requests")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending:false });

    res.json(data || []);

  } catch (err) {
    console.error(err);
    res.json([]);
  }
});


// ===== 玩家：我的提款记录 =====
app.get("/my-withdraw-requests/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    const { data } = await supabase
      .from("withdraw_requests")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending:false });

    res.json(data || []);

  } catch (err) {
    console.error(err);
    res.json([]);
  }
});

// ===== 玩家申请充值 =====
app.post("/request-recharge", async (req, res) => {

  try{

    const {
      userId,
      username,
      amount,
      paymentMethod,
      payerName,
      note
    } = req.body;

    const rechargeAmount = Number(amount);

    if (!userId || !username) {
      return res.json({ success:false, msg:"ข้อมูลผู้เล่นไม่ถูกต้อง" });
    }

    if (!rechargeAmount || isNaN(rechargeAmount)) {
      return res.json({ success:false, msg:"กรุณากรอกจำนวนเงินฝาก" });
    }

    if (rechargeAmount <= 0) {
      return res.json({ success:false, msg:"จำนวนเงินฝากต้องมากกว่า 0" });
    }

    if (rechargeAmount > 1000000) {
      return res.json({ success:false, msg:"จำนวนเงินฝากสูงเกินไป" });
    }

    if (!paymentMethod || !payerName) {
      return res.json({ success:false, msg:"กรุณากรอกข้อมูลการโอนให้ครบ" });
    }

    const now = Date.now();

    if (rechargeCooldown[userId] && now - rechargeCooldown[userId] < 10000) {
      return res.json({ success:false, msg:"กรุณารอสักครู่ก่อนส่งคำขออีกครั้ง" });
    }

    rechargeCooldown[userId] = now;

    const { data: pending } = await supabase
      .from("recharge_requests")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "pending");

    if (pending && pending.length >= 3) {
      return res.json({
        success:false,
        msg:"คุณมีรายการฝากที่รอตรวจสอบอยู่ กรุณารอแอดมิน"
      });
    }

    const { error } = await supabase
      .from("recharge_requests")
      .insert([{
        user_id:userId,
        username,
        amount: rechargeAmount,
        payment_method: paymentMethod,
        payer_name: payerName,
        note,
        status:"pending"
      }]);

    if(error){
      console.log(error);
      return res.status(500).json({ success:false, msg:"ส่งคำขอฝากไม่สำเร็จ" });
    }

    res.json({ success:true, msg:"ส่งคำขอฝากเงินเรียบร้อยแล้ว" });

  }catch(err){
    console.log(err);
    res.status(500).json({ success:false, msg:"ระบบผิดพลาด" });
  }

});


// ===== 玩家申请提款 =====
app.post("/request-withdraw", async (req, res) => {

  try{

    const {
      userId,
      username,
      amount,
      bankName,
      bankAccount,
      note
    } = req.body;

    const withdrawAmount = Number(amount);

    if (!userId || !username) {
      return res.json({ success:false, msg:"ข้อมูลผู้เล่นไม่ถูกต้อง" });
    }

    if (!withdrawAmount || isNaN(withdrawAmount)) {
      return res.json({ success:false, msg:"กรุณากรอกจำนวนเงินถอน" });
    }

    if (withdrawAmount <= 0) {
      return res.json({ success:false, msg:"จำนวนเงินถอนต้องมากกว่า 0" });
    }

    if (!bankName || !bankAccount) {
      return res.json({ success:false, msg:"กรุณากรอกข้อมูลบัญชีธนาคารให้ครบ" });
    }

    const now = Date.now();

    if (withdrawCooldown[userId] && now - withdrawCooldown[userId] < 10000) {
      return res.json({ success:false, msg:"กรุณารอสักครู่ก่อนส่งคำขออีกครั้ง" });
    }

    withdrawCooldown[userId] = now;

    const { data: player } = await supabase
      .from("players")
      .select("*")
      .eq("user_id", userId)
      .single();

    if (!player) {
      return res.json({ success:false, msg:"ไม่พบบัญชีผู้เล่น" });
    }

    if (Number(player.balance || 0) < withdrawAmount) {
      return res.json({ success:false, msg:"ยอดเงินไม่เพียงพอ" });
    }

    const { data: pending } = await supabase
      .from("withdraw_requests")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "pending");

    if (pending && pending.length >= 1) {
      return res.json({
        success:false,
        msg:"คุณมีรายการถอนที่รอตรวจสอบอยู่ กรุณารอแอดมิน"
      });
    }

    const { error } = await supabase
      .from("withdraw_requests")
      .insert([{
        user_id:userId,
        username,
        amount: withdrawAmount,
        bank_name:bankName,
        bank_account:bankAccount,
        note,
        status:"pending"
      }]);

    if(error){
      console.log(error);
      return res.status(500).json({ success:false, msg:"ส่งคำขอถอนไม่สำเร็จ" });
    }

    res.json({ success:true, msg:"ส่งคำขอถอนเงินเรียบร้อยแล้ว" });

  }catch(err){
    console.log(err);
    res.status(500).json({ success:false, msg:"ระบบผิดพลาด" });
  }

});
 

// ===== 启动 =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("RUNNING ON", PORT);
});
