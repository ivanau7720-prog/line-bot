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

app.get("/shop.html", (req, res) => {
  res.sendFile(__dirname + "/public/shop.html");
});

app.use(express.static("public"));
app.use(express.static(__dirname));
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

async function logAdminAction(

adminName,
actionType,
targetUser,
amount,
note

){

try{

await supabase

.from("admin_logs")

.insert([{

admin_name:
adminName || "admin",

action_type:
actionType,

target_user:
targetUser || "",

amount:
Number(amount || 0),

note:
note || ""

}]);

}catch(err){

console.log(
"admin log error",
err
);

}

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

ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS commission_before NUMERIC DEFAULT 0;

ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS commission_after NUMERIC DEFAULT 0;

ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS admin_note TEXT;

ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS settled_by TEXT;

ALTER TABLE players
ADD COLUMN IF NOT EXISTS bank_name TEXT;
ALTER TABLE players
ADD COLUMN IF NOT EXISTS bank_account TEXT;

ALTER TABLE players
ADD COLUMN IF NOT EXISTS phone TEXT;

ALTER TABLE players
ADD COLUMN IF NOT EXISTS email TEXT;

ALTER TABLE players
ADD COLUMN IF NOT EXISTS avatar TEXT;

ALTER TABLE players
ADD COLUMN IF NOT EXISTS password TEXT;

ALTER TABLE players
ADD COLUMN IF NOT EXISTS agent_code TEXT;

ALTER TABLE agents
ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';

ALTER TABLE agents
ADD COLUMN IF NOT EXISTS current_level TEXT DEFAULT 'BRONZE';

ALTER TABLE agents
ADD COLUMN IF NOT EXISTS current_rate NUMERIC DEFAULT 20;

CREATE TABLE IF NOT EXISTS agent_level_logs (
id BIGSERIAL PRIMARY KEY,
agent_code TEXT,
old_level TEXT,
new_level TEXT,
old_rate NUMERIC DEFAULT 0,
new_rate NUMERIC DEFAULT 0,
valid_players NUMERIC DEFAULT 0,
total_topup NUMERIC DEFAULT 0,
created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS point_records (
id BIGSERIAL PRIMARY KEY,
user_id TEXT,
point NUMERIC DEFAULT 0,
type TEXT,
note TEXT,
created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS exchange_records (
id BIGSERIAL PRIMARY KEY,

user_id TEXT,

item_name TEXT,

point_cost NUMERIC DEFAULT 0,

status TEXT DEFAULT 'pending',

shipping_note TEXT,

created_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE exchange_records
ADD COLUMN IF NOT EXISTS shipping_note TEXT;

CREATE TABLE IF NOT EXISTS chat_messages (
id BIGSERIAL PRIMARY KEY,
user_id TEXT,
username TEXT,
message TEXT,
type TEXT DEFAULT 'real',
created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_logs (

id BIGSERIAL PRIMARY KEY,

admin_name TEXT,

action_type TEXT,

target_user TEXT,

amount NUMERIC DEFAULT 0,

note TEXT,

created_at TIMESTAMP DEFAULT NOW()

);

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

  currentRound: 0,

  roundDbId: null,

  bets: {},

  timer: null,

  timeLeft: 60,

  roundStartTime: null,

  bettingDuration: 60
};

let playersCache = {};
let betCooldown = {};
let rechargeCooldown = {};
let withdrawCooldown = {};
let onlineUsers = {};
let chatCooldown = {};
// ===== 恢复进行中的局 =====
async function restoreActiveRound(){

  try{

    const { data } = await supabase
      .from("rounds")
      .select("*")
      .eq("status", "betting")
      .order("created_at", { ascending:false })
      .limit(1)
      .maybeSingle();

    if(!data) return;

    const start = new Date(data.start_time).getTime();
    const duration = 60;
    const elapsed = Math.floor((Date.now() - start) / 1000);
    const left = Math.max(duration - elapsed, 0);

    GAME.currentRound = data.round_no || 0;
    GAME.roundDbId = data.id;
    GAME.roundStartTime = start;
    GAME.bettingDuration = duration;
    GAME.timeLeft = left;
    GAME.bets = {};
const { data: bets } = await supabase
  .from("transactions")
  .select("*")
  .eq("round_id", data.id)
  .eq("type", "bet");

for (const b of bets || []) {

  if (GAME.bets[b.user_id]) {
    GAME.bets[b.user_id].amount += Number(b.amount || 0);
    GAME.bets[b.user_id].side = b.bet_side;
  } else {
    GAME.bets[b.user_id] = {
      side: b.bet_side,
      amount: Number(b.amount || 0)
    };
  }

}
    if(left > 0){

      GAME.roundActive = true;
      GAME.isBetting = true;

      GAME.timer = setInterval(() => {

        const e = Math.floor((Date.now() - GAME.roundStartTime) / 1000);
        GAME.timeLeft = Math.max(GAME.bettingDuration - e, 0);

        if(GAME.timeLeft <= 0){
          GAME.isBetting = false;
          clearInterval(GAME.timer);
        }

      }, 1000);

    } else {

      GAME.roundActive = true;
      GAME.isBetting = false;
      GAME.timeLeft = 0;

    }

    console.log("Restored active round", GAME.currentRound);

  }catch(err){

    console.error("restoreActiveRound error:", err);

  }

}

restoreActiveRound();
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
app.post("/start", async (req, res) => {
  try {

    if (GAME.roundActive && !GAME.isBetting) {
      return res.json({
        success:false,
        msg:"上一局已停止下注，请先开奖或强制重置"
      });
    }

    if (GAME.roundActive && GAME.isBetting) {
      return res.json({
        success:false,
        msg:"已在进行中"
      });
    }

    GAME.roundActive = true;
    GAME.currentRound = (GAME.currentRound || 0) + 1;
    GAME.isBetting = true;
    GAME.bets = {};
    GAME.bettingDuration = 60;
    GAME.timeLeft = 60;
    GAME.roundStartTime = Date.now();

    const { data: newRound } = await supabase
      .from("rounds")
      .insert([
        {
          round_no: GAME.currentRound,
          status: "betting",
          start_time: new Date(GAME.roundStartTime).toISOString()
        }
      ])
      .select()
      .single();

    GAME.roundDbId = newRound.id;

    GAME.timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - GAME.roundStartTime) / 1000);
      GAME.timeLeft = Math.max(GAME.bettingDuration - elapsed, 0);

      if (GAME.timeLeft <= 0) {
        GAME.isBetting = false;
        clearInterval(GAME.timer);
      }
    }, 1000);

    res.json({
      success:true,
      msg:"开局成功"
    });

  } catch (err) {
    console.error("start error:", err);
    res.status(500).json({
      success:false,
      msg:"开局失败"
    });
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

/* 防庄闲对冲 */

if (GAME.bets[userId]) {

  const oldSide =
  GAME.bets[userId].side;

  if (

    (oldSide==="B" && side==="P")

    ||

    (oldSide==="P" && side==="B")

  ){

    return res.json({
      success:false,
      msg:"同一局不能同时买庄和闲"
    });

  }

}

await changeBalance(
userId,
-betAmount
);
await supabase.from("turnover_records").insert([
  {
    user_id: userId,
    agent_code: user.agent_code || null,
    amount: betAmount,
    bet_side: side,
    type: "bet"
  }
]);
await supabase.from("transactions").insert([
  {
    user_id: userId,
    amount: betAmount,
    bet_side: side,
    type: "bet",
    round_id: GAME.roundDbId
  }
]);
 if (GAME.bets[userId]) {

  GAME.bets[userId].amount += betAmount;

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
// ===== 停止下注 =====
app.post("/stop", async (req, res) => {
  try {

    if (!GAME.roundActive) {
      return res.json({
        success:false,
        msg:"没有进行中的局"
      });
    }

    GAME.isBetting = false;
    GAME.timeLeft = 0;

    if (GAME.timer) {
      clearInterval(GAME.timer);
      GAME.timer = null;
    }

    await supabase
      .from("rounds")
      .update({
        status:"closed"
      })
      .eq("id", GAME.roundDbId);

    res.json({
      success:true,
      msg:"已停止下注"
    });

  } catch (err) {
    console.error("stop error:", err);
    res.json({
      success:false,
      msg:"停止失败"
    });
  }
});
// ===== 管理员：强制重置游戏 =====
app.post("/admin/reset-game", checkAdmin, async (req, res) => {
  try {

    GAME.isBetting = false;
    GAME.roundActive = false;
    GAME.bets = {};
    GAME.timeLeft = 60;
    GAME.roundStartTime = null;

    if (GAME.timer) {
      clearInterval(GAME.timer);
      GAME.timer = null;
    }

    if (GAME.roundDbId) {
      await supabase
        .from("rounds")
        .update({
          status:"cancelled"
        })
        .eq("id", GAME.roundDbId);
    }

    GAME.roundDbId = null;

    res.json({
      success:true,
      msg:"游戏已重置"
    });

  } catch (err) {
    console.error("reset-game error:", err);
    res.json({
      success:false,
      msg:"重置失败"
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
  .update({
    result: result,
    status: "done",
    end_time: new Date().toISOString()
  })
  .eq("id", GAME.roundDbId)
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

      let win = 0;
let lose = 0;
let payout = 0;

if (bet.side === result) {

  if (result === "B") {

    payout = Math.floor(bet.amount * 1.95);

  } else if (result === "P") {

    payout = bet.amount * 2;

  } else if (result === "T") {

    payout = bet.amount * 9;

  }

  await changeBalance(uid, payout);

  win = payout;

} else {

  lose = bet.amount;

}

      await supabase
  .from("players")
  .update({
    total_win: Number(data.total_win || 0) + win,
    total_lose: Number(data.total_lose || 0) + lose
  })
  .eq("user_id", uid);
// 👇👇👇 更新本局下注结算流水
await supabase
  .from("transactions")
  .update({
    result: result,
    win_amount: payout,
    type: payout > 0 ? "win" : "lose"
  })
  .eq("round_id", roundId)
  .eq("user_id", uid);
 }
GAME.bets = {};

GAME.timeLeft = 60;

GAME.roundStartTime = null;

clearInterval(GAME.timer);

GAME.timer = null;

res.json({
msg:"结算完成"
});

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

// ===== 玩家在线心跳 =====
app.post("/heartbeat", (req, res) => {
  const { userId, page } = req.body;

  if(userId){
    onlineUsers[userId] = {
      time: Date.now(),
      page: page || "live"
    };
  }

  res.json({ success:true });
});


// ===== Staff Monitor 真实数据 =====
app.get("/admin/monitor-data", checkAdmin, async (req, res) => {
  try{

    const now = Date.now();

    let online = 0;
    let watching = 0;

    Object.values(onlineUsers).forEach(u=>{
      if(now - u.time < 60000){
        online++;

        if(u.page === "live"){
          watching++;
        }
      }
    });

    let bankerUsers = 0;
    let playerUsers = 0;
    let tieUsers = 0;

    let bankerAmount = 0;
    let playerAmount = 0;
    let tieAmount = 0;

    for(const uid in GAME.bets){
      const bet = GAME.bets[uid];

      if(bet.side === "B"){
        bankerUsers++;
        bankerAmount += Number(bet.amount || 0);
      }

      if(bet.side === "P"){
        playerUsers++;
        playerAmount += Number(bet.amount || 0);
      }

      if(bet.side === "T"){
        tieUsers++;
        tieAmount += Number(bet.amount || 0);
      }
    }

    const totalBet =
      bankerAmount + playerAmount + tieAmount;

    const profitIfBanker =
      totalBet - (bankerAmount * 1.95);

    const profitIfPlayer =
      totalBet - (playerAmount * 2);

    const profitIfTie =
      totalBet - (tieAmount * 9);

    res.json({
      online,
      watching,
      totalBetUsers: bankerUsers + playerUsers + tieUsers,

      bankerUsers,
      playerUsers,
      tieUsers,

      bankerAmount,
      playerAmount,
      tieAmount,

      profitIfBanker,
      profitIfPlayer,
      profitIfTie,

      round: GAME.currentRound || 0,
      timeLeft: GAME.timeLeft || 0,
      isBetting: GAME.isBetting
    });

  }catch(err){
    console.error("monitor-data error:", err);

    res.json({
      online:0,
      watching:0,
      totalBetUsers:0,

      bankerUsers:0,
      playerUsers:0,
      tieUsers:0,

      bankerAmount:0,
      playerAmount:0,
      tieAmount:0,

      profitIfBanker:0,
      profitIfPlayer:0,
      profitIfTie:0,

      round:0,
      timeLeft:0,
      isBetting:false
    });
  }
});

// ===== 状态 =====
app.get("/state", (req, res) => {
  let status = "idle";

  if (GAME.roundActive && GAME.isBetting) {
    status = "betting";
  } else if (GAME.roundActive && !GAME.isBetting) {
    status = "closed";
  }

  if (GAME.roundActive && GAME.roundStartTime) {
    const elapsed = Math.floor((Date.now() - GAME.roundStartTime) / 1000);
    GAME.timeLeft = Math.max(GAME.bettingDuration - elapsed, 0);

    if (GAME.timeLeft <= 0) {
      GAME.isBetting = false;
      GAME.timeLeft = 0;
      status = "closed";
    }
  }

  res.json({
    status,
    isBetting: GAME.isBetting,
    roundActive: GAME.roundActive,
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

balance:
Number(
data?.balance || 0
),

point:
Number(
data?.reward_points || 0
),

vip:
Number(
data?.vip_level || 10
),

total_topup:
Number(
data?.total_topup || 0
),

total_withdraw:
Number(
data?.total_withdraw || 0
),

bank_name:
data?.bank_name || "",

bank_account:
data?.bank_account || "",

phone:
data?.phone || "",

email:
data?.email || "",

avatar:
data?.avatar || "👤"

});

  } catch (err) {
    console.error(err);
res.json({

balance:0,

point:0,

vip:10,

total_topup:0,

total_withdraw:0,

bank_name:"",

bank_account:"",

phone:"",

email:"",

avatar:"👤"

});
}
});    
// ===== 玩家：更新个人资料 =====
app.post("/update-profile", async (req, res) => {
  try {

    const {
      user_id,
      bank_name,
      bank_account,
      phone,
      email,
avatar
} = req.body;

    if (!user_id) {
      return res.json({
        success:false,
        msg:"缺少用户ID"
      });
    }

    const { error } = await supabase
      .from("players")
      .update({
        bank_name: bank_name || "",
        bank_account: bank_account || "",
        phone: phone || "",
        email: email || "",
avatar: avatar || "👤"
      })
      .eq("user_id", user_id);

    if (error) {
      console.error("update-profile error:", error);
      return res.json({
        success:false,
        msg:"保存失败"
      });
    }

    res.json({
      success:true
    });

  } catch (err) {
    console.error("update-profile catch:", err);
    res.json({
      success:false
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
    agent_name: agentName,
    status: "active"
  }
]);

    res.json({ success:true });

  } catch (err) {
    console.error(err);
    res.json({ success:false });
  }
});
function getAgentLevel(validPlayers,totalTopup){

if(
validPlayers >= 400 &&
totalTopup >= 10000000
){

return {
level:"DIAMOND",
rate:35
};

}

if(
validPlayers >= 151 &&
totalTopup >= 2000001
){

return {
level:"GOLD",
rate:30
};

}

if(
validPlayers >= 51 &&
totalTopup >= 500001
){

return {
level:"SILVER",
rate:25
};

}

return {
level:"BRONZE",
rate:20
};

}

async function checkAndLogAgentLevel(
agentCode,
oldLevel,
oldRate,
newLevel,
newRate,
validPlayers,
totalTopup
){

try{

if(
oldLevel === newLevel &&
Number(oldRate) === Number(newRate)
){
return;
}

await supabase
.from("agent_level_logs")
.insert([{
agent_code: agentCode,
old_level: oldLevel || "BRONZE",
new_level: newLevel,
old_rate: Number(oldRate || 20),
new_rate: Number(newRate || 20),
valid_players: Number(validPlayers || 0),
total_topup: Number(totalTopup || 0)
}]);

await supabase
.from("agents")
.update({
current_level: newLevel,
current_rate: newRate
})
.eq("agent_code", agentCode);

}catch(err){

console.log("agent level log error:", err);

}

}

// ===== 管理员：启用 / 停用代理 =====
app.post("/admin/update-agent-status", checkAdmin, async (req, res) => {
  try {
    const { agentCode, status } = req.body;

    if(
      !agentCode ||
      !["active","inactive"].includes(status)
    ){
      return res.json({
        success:false,
        msg:"资料错误"
      });
    }

    await supabase
      .from("agents")
      .update({
        status
      })
      .eq("agent_code", agentCode);

    res.json({
      success:true
    });

  } catch (err) {
    console.error("update-agent-status error:", err);
    res.json({
      success:false
    });
  }
});
// ===== 管理员：代理佣金结算 =====
app.post("/admin/settle-agent-commission", checkAdmin, async (req, res) => {

try{

const {
agentCode,
commission,
adminNote
} = req.body;

const commissionBefore =
Number(commission || 0);

if(
!agentCode ||
commissionBefore <= 0
){

return res.json({
success:false,
msg:"资料错误"
});

}

const today =
new Date().toISOString().slice(0,10);

const { data: exist } =
await supabase
.from("transactions")
.select("*")
.eq("user_id", agentCode)
.eq("type", "agent_commission_settled")
.gte("created_at", today + "T00:00:00")
.lte("created_at", today + "T23:59:59");

if(
exist &&
exist.length > 0
){

return res.json({
success:false,
msg:"今天已经结算过这个代理"
});

}

await supabase
.from("transactions")
.insert([{

user_id: agentCode,
amount: commissionBefore,
type: "agent_commission_settled",
note: "Agent commission settled",
commission_before: commissionBefore,
commission_after: 0,
admin_note: adminNote || "",
settled_by: "admin"

}]);
  
await logAdminAction(
"admin",
"结算代理佣金",
agentCode,
commissionBefore,
adminNote || "Agent commission settled"
);
res.json({
success:true
});

}catch(err){

console.log(err);

res.json({
success:false,
msg:"结算失败"
});

}

});

// ===== 管理员：代理等级升级历史 =====
app.get("/admin/agent-level-history/:agentCode", checkAdmin, async (req, res) => {

try{

const { agentCode } = req.params;

const { data } = await supabase
.from("agent_level_logs")
.select("*")
.eq("agent_code", agentCode)
.order("created_at", {
ascending:false
})
.limit(20);

res.json({
success:true,
records:data || []
});

}catch(err){

console.log("agent level history error:", err);

res.json({
success:false,
records:[]
});

}

});
// ===== 管理员：代理佣金历史 =====
app.get("/admin/agent-commission-history/:agentCode", checkAdmin, async (req, res) => {

try{

const {
agentCode
}
=
req.params;

const {
data
}
=
await supabase
.from("transactions")
.select("*")
.eq("user_id", agentCode)
.eq("type", "agent_commission_settled")
.order("created_at", {
ascending:false
})
.limit(20);

res.json({
success:true,
records:data || []
});

}catch(err){

console.log(err);

res.json({
success:false,
records:[]
});

}

});
// ===== 管理员：代理详情 =====
app.get("/admin/agent-detail/:agentCode", checkAdmin, async (req, res) => {
  try {

    const { agentCode } = req.params;

    const { data: players } = await supabase
      .from("players")
      .select("*")
      .eq("agent_code", agentCode);

    const { data: turnover } = await supabase
      .from("turnover_records")
      .select("*")
      .eq("agent_code", agentCode);

    const list = (players || []).map(p => {

      const playerTurnover = (turnover || [])
        .filter(t => t.user_id === p.user_id)
        .reduce((sum, t) => {
          return sum + Number(t.amount || 0);
        }, 0);

    return {

user_id: p.user_id,

username: p.username || p.name || "-",

vip:
Number(
p.vip_level || 10
),

register_date:
p.created_at || "",

last_login:
p.last_login || "",

balance:
Number(
p.balance || 0
),

total_topup:
Number(
p.total_topup || 0
),

total_win:
Number(
p.total_win || 0
),

total_lose:
Number(
p.total_lose || 0
),

turnover:
playerTurnover

};

    });

    res.json({
      success:true,
      players:list
    });

  } catch (err) {

    console.error("agent-detail error:", err);

    res.json({
      success:false,
      players:[]
    });

  }
});

// ===== 管理员：玩家详情弹窗 =====
// ===== 管理员：玩家详情弹窗 =====
app.get("/admin/player-detail/:userId", checkAdmin, async (req, res) => {
  try {

    const { userId } = req.params;

    const { data: player } = await supabase
      .from("players")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    if (!player) {
      return res.json({
        success:false
      });
    }

    const { data: txs } = await supabase
      .from("transactions")
      .select("*")
      .eq("user_id", userId);

    const transactions =
    txs || [];

    const totalTurnover =
    transactions.reduce((sum, t) => {
      return sum + Number(t.amount || 0);
    }, 0);

    const totalBets =
    transactions.length;

    const today =
    new Date().toISOString().slice(0,10);

    const todayTxs =
    transactions.filter(t =>
      String(t.created_at || "").slice(0,10) === today
    );

   const todayWinLose =
todayTxs.reduce((sum, t) => {

  if(t.type === "win"){
    return sum + Number(t.win_amount || 0) - Number(t.amount || 0);
  }

  if(t.type === "lose"){
    return sum - Number(t.amount || 0);
  }

  return sum + Number(t.change || 0);

}, 0);

    res.json({
      success:true,

      user_id:
      player.user_id,

      username:
      player.username || player.name || "-",

      agent_code:
      player.agent_code || "-",

      vip:
      Number(player.vip_level || 10),

      balance:
      Number(player.balance || 0),

      total_topup:
      Number(player.total_topup || 0),

      total_withdraw:
      Number(player.total_withdraw || 0),

      total_win:
      Number(player.total_win || 0),

      total_lose:
      Number(player.total_lose || 0),

      total_turnover:
      Number(totalTurnover || 0),

      total_bets:
      Number(totalBets || 0),

      today_winlose:
      Number(todayWinLose || 0),

      register_date:
      player.created_at || "-",

      last_login:
      player.last_login || "-",

      status:
      player.status || "active"
    });

  } catch (err) {

    console.error("player-detail error:", err);

    res.json({
      success:false
    });
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
      
const sevenDaysAgo = new Date();
sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      let totalTurnover = 0;

      (turnover || []).forEach(t => {
        totalTurnover += Number(t.amount || 0);
      });

 let totalTopup = 0;
let validPlayers = 0;
let totalPlayerLoss = 0;

let weeklyNewPlayers = 0;
let weeklyTopup = 0;
const playerIds =
(players || []).map(p => p.user_id);

let weeklyRecharge = [];

if(playerIds.length > 0){

  const { data } = await supabase
    .from("transactions")
    .select("user_id, amount, created_at")
    .in("user_id", playerIds)
    .eq("type", "recharge_approved")
    .gte("created_at", sevenDaysAgo.toISOString());

  weeklyRecharge = data || [];

}

weeklyRecharge.forEach(r=>{
  weeklyTopup += Number(r.amount || 0);
});
for(const p of players || []){

const playerTopup =
Number(p.total_topup || 0);

const playerBalance =
Number(p.balance || 0);

const playerWithdraw =
Number(p.total_withdraw || 0);

const playerLoss =
Math.max(
playerTopup - playerBalance - playerWithdraw,
0
);

totalTopup += playerTopup;
totalPlayerLoss += playerLoss;
if(
  p.created_at &&
  new Date(p.created_at) >= sevenDaysAgo
){
  weeklyNewPlayers++;
}


const playerBetCount =
(turnover || [])
.filter(t => t.user_id === p.user_id)
.length;

if(
playerTopup >= 1000 &&
playerBetCount >= 5
){

validPlayers++;

}

}

const levelData =
getAgentLevel(
validPlayers,
totalTopup
);

await checkAndLogAgentLevel(
a.agent_code,
a.current_level || "BRONZE",
a.current_rate || 20,
levelData.level,
levelData.rate,
validPlayers,
totalTopup
);
      
const commission =
Math.floor(
totalPlayerLoss *
levelData.rate /
100
);
const today =
new Date()
.toISOString()
.slice(0,10);

const { data: settledToday } =
await supabase
.from("transactions")
.select("*")
.eq("user_id", a.agent_code)
.eq("type", "agent_commission_settled")
.gte("created_at", today + "T00:00:00")
.lte("created_at", today + "T23:59:59");

const todaySettled =
settledToday &&
settledToday.length > 0;
list.push({

agent_code: a.agent_code,

agent_name: a.agent_name,

status: a.status || "active",

player_count: players ? players.length : 0,

valid_players: validPlayers,

total_turnover: totalTurnover,

total_topup: totalTopup,

weekly_new_players:
weeklyNewPlayers,

weekly_topup:
weeklyTopup,

player_loss: totalPlayerLoss,

level: levelData.level,

commission_rate: levelData.rate,

commission: commission,

today_settled: todaySettled
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
  vip: p.vip_level || 10,
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
  try {

    const { data } = await supabase
      .from("rounds")
      .select("*")
      .order("id", { ascending: false })
      .limit(20);

    res.json(data || []);

  } catch (err) {
    console.error("admin rounds error:", err);
    res.json([]);
  }
});


// ===== 管理员：操作日志列表 =====
app.get("/admin/logs", checkAdmin, async (req, res) => {
try{

const { data } = await supabase
.from("admin_logs")
.select("*")
.order("id", { ascending:false })
.limit(100);

res.json({
success:true,
logs:data || []
});

}catch(err){

console.error("admin logs error:", err);

res.json({
success:false,
logs:[]
});

}

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
  let profit = 0;

  if (t.type === "lose") {
    profit = Number(t.amount || 0);
  }

  if (t.type === "win") {
    profit = Number(t.amount || 0) - Number(t.win_amount || 0);
  }

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
await logAdminAction(
"admin",
"管理员加钱",
userId,
amount,
"Admin add balance"
);
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
await logAdminAction(
"admin",
"管理员扣钱",
userId,
amount,
"Admin minus balance"
);
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
let finalAgent = null;

if(agentCode){

const { data: existAgent } =
await supabase
.from("agents")
.select("agent_code,status")
.eq(
"agent_code",
agentCode
)
.maybeSingle();

if(
existAgent
&&
existAgent.status === "active"
){

finalAgent =
agentCode;

}

}
await supabase.from("players").insert([{
  user_id:userId,
  username,
  password,
  name:username,
  balance:1000,
  agent_code:finalAgent
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

// ===== 管理员：今日充值记录 =====
app.get("/admin/today-recharge", checkAdmin, async (req, res) => {
try{

const today =
new Date().toISOString().slice(0,10);

const { data } =
await supabase
.from("transactions")
.select("*")
.eq("type", "recharge_approved")
.gte("created_at", today + "T00:00:00")
.lte("created_at", today + "T23:59:59")
.order("created_at", { ascending:false });

let total = 0;

(data || []).forEach(r=>{
total += Number(r.amount || 0);
});

res.json({
success:true,
total,
count:(data || []).length,
records:data || []
});

}catch(err){

console.error("today recharge error:", err);

res.json({
success:false,
total:0,
count:0,
records:[]
});

}

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

    const rechargeAmount =
Number(request.amount);

const newBalance =
Number(player.balance || 0) + rechargeAmount;

const newTopup =
Number(player.total_topup || 0) + rechargeAmount;

/* Point 规则：充值 100 = 10 Point */
const addPoint =
Math.floor(rechargeAmount / 100) * 10;

const newPoint =
Number(player.reward_points || 0) + addPoint;

/* VIP 规则：累计充值越高，VIP 越高 */
let newVip = 10;

if(newTopup >= 10000) newVip = 9;
if(newTopup >= 20000) newVip = 8;
if(newTopup >= 40000) newVip = 7;
if(newTopup >= 80000) newVip = 6;
if(newTopup >= 150000) newVip = 5;
if(newTopup >= 300000) newVip = 4;
if(newTopup >= 500000) newVip = 3;
if(newTopup >= 800000) newVip = 2;
if(newTopup >= 1000000) newVip = 1;

await supabase
  .from("players")
  .update({
    balance: newBalance,
    total_topup: newTopup,
    reward_points: newPoint,
    vip_level: newVip
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
    await logAdminAction(
"admin",
"批准充值",
request.user_id,
request.amount,
"Recharge approved"
);
if(addPoint > 0){
await supabase.from("point_records").insert([{
  user_id: request.user_id,
  point: addPoint,
  type: "recharge_point",
  note: "Recharge reward"
}]);
}
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

const { data: request } =
await supabase
.from("recharge_requests")
.select("*")
.eq("id", id)
.single();

await supabase
.from("recharge_requests")
.update({ status:"rejected" })
.eq("id", id);

await logAdminAction(
"admin",
"拒绝充值",
request?.user_id || "",
request?.amount || 0,
"Recharge rejected"
);

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
await logAdminAction(
"admin",
"批准提款",
request.user_id,
request.amount,
"Withdraw approved"
);
    res.json({ success:true });

  } catch (err) {
    console.error(err);
    res.json({ success:false });
  }
});


// ===== 管理员：拒绝提款 =====
app.post("/admin/reject-withdraw", checkAdmin, async (req, res) => {
try{

const { id } = req.body;

const { data: request } =
await supabase
.from("withdraw_requests")
.select("*")
.eq("id", id)
.single();

await supabase
.from("withdraw_requests")
.update({
status:"rejected"
})
.eq("id", id);

await logAdminAction(
"admin",
"拒绝提款",
request?.user_id || "",
request?.amount || 0,
"Withdraw rejected"
);

res.json({
success:true
});

}catch(err){

console.error(err);

res.json({
success:false
});

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

// ===== 玩家：我的积分记录 =====
app.get("/my-point-records/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    const { data } = await supabase
      .from("point_records")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending:false });

    res.json(data || []);

  } catch (err) {
    console.error(err);
    res.json([]);
  }
});

// ===== 玩家：我的兑换记录 =====
app.get("/my-exchange-records/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    const { data } = await supabase
      .from("exchange_records")
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
 
// ===== 玩家：积分商城兑换 =====
app.post("/exchange", async (req, res) => {

  try {

    const {
      userId,
      itemName,
      cost
    } = req.body;
const vipMap={

"1g 金条":5,

"AirPods Pro":5,

"Apple Watch":5,

"iPad Air":3,

"MacBook Air":3,

"5g 金条":2,

"iPhone Pro Max":1,

"ทองคำ 1 กรัม":5,
"ทองคำ 5 กรัม":2

};
    if (!userId || !itemName || !cost) {
      return res.json({
        success:false,
        msg:"资料不完整"
      });
    }

    const { data: player } = await supabase
      .from("players")
      .select("*")
      .eq("user_id", userId)
      .single();

    if (!player) {
      return res.json({
        success:false,
        msg:"找不到玩家"
      });
    }
const userVip =
Number(player.vip_level || 10);

const needVip =
vipMap[itemName] || 10;

if(userVip > needVip){

  return res.json({
    success:false,
    msg:"VIP等级不足"
  });

}
    const currentPoint = Number(player.reward_points || 0);
    const pointCost = Number(cost);

    if (currentPoint < pointCost) {
      return res.json({
        success:false,
        msg:"积分不足"
      });
    }

    const newPoint = currentPoint - pointCost;

    await supabase
      .from("players")
      .update({
        reward_points:newPoint
      })
      .eq("user_id", userId);

   const isBonus =
itemName.toLowerCase().includes("bonus");

await supabase
  .from("exchange_records")
  .insert([{
    user_id:userId,
    item_name:itemName,
    point_cost:pointCost,
    status: isBonus ? "approved" : "pending"
  }]);

    await supabase
      .from("point_records")
      .insert([{
        user_id:userId,
        point:-pointCost,
        type:"exchange",
        note:"Exchange " + itemName
      }]);

    res.json({
      success:true,
      msg:"兑换申请已提交"
    });

  } catch (err) {

    console.error("exchange error:", err);

    res.json({
      success:false,
      msg:"兑换失败"
    });

  }

});

// ===== 管理员：查看兑换申请 =====
app.get("/admin/exchange-records", checkAdmin, async (req, res) => {
  try {

const { data: records } = await supabase
.from("exchange_records")
.select("*")
.order("created_at",{
ascending:false
});

const { data: players } = await supabase
.from("players")
.select(`
user_id,
username,
name,
vip_level
`);

const list=(records||[]).map(r=>{

const player=
(players||[])
.find(
p=>p.user_id===r.user_id
);

return{

...r,

player_name:
player?.username
||
player?.name
||
"未知玩家",

vip_level:
player?.vip_level
||
10

};

});

res.json(list);

}catch(err){

console.error(
"admin exchange records error:",
err
);

res.json([]);

}

});


// ===== 管理员：批准兑换 =====
app.post("/admin/approve-exchange", checkAdmin, async (req, res) => {
  try {

    const { id } = req.body;

    await supabase
      .from("exchange_records")
      .update({ status:"approved" })
      .eq("id", id);

    res.json({ success:true });

  } catch (err) {
    console.error("approve exchange error:", err);
    res.json({ success:false });
  }
});


// ===== 管理员：拒绝兑换 =====
app.post("/admin/reject-exchange", checkAdmin, async (req, res) => {
  try {

    const { id } = req.body;

    const { data: record } = await supabase
      .from("exchange_records")
      .select("*")
      .eq("id", id)
      .single();

    if (!record || record.status !== "pending") {
      return res.json({
        success:false,
        msg:"申请不存在或已处理"
      });
    }

    const { data: player } = await supabase
      .from("players")
      .select("*")
      .eq("user_id", record.user_id)
      .single();

    const newPoint =
      Number(player.reward_points || 0) +
      Number(record.point_cost || 0);

    await supabase
      .from("players")
      .update({ reward_points:newPoint })
      .eq("user_id", record.user_id);

    await supabase
      .from("exchange_records")
      .update({ status:"rejected" })
      .eq("id", id);

    await supabase
      .from("point_records")
      .insert([{
        user_id:record.user_id,
        point:Number(record.point_cost || 0),
        type:"exchange_refund",
        note:"Exchange rejected refund"
      }]);

    res.json({ success:true });

  } catch (err) {
    console.error("reject exchange error:", err);
    res.json({ success:false });
  }
});


// ===== 管理员：兑换完成 / 已发货 =====
app.post("/admin/done-exchange", checkAdmin, async (req, res) => {
  try {

    const { id, shippingNote } = req.body;

await supabase
  .from("exchange_records")
  .update({
    status:"done",
    shipping_note: shippingNote || ""
  })
  .eq("id", id);

    res.json({ success:true });

  } catch (err) {
    console.error("done exchange error:", err);
    res.json({ success:false });
  }
});

// ===== LIVE CHAT：发送消息 =====
app.post("/chat/send", async (req, res) => {
  try {

    const {
      userId,
      username,
      message
    } = req.body;

    if (!userId || !username) {
      return res.json({
        success:false,
        msg:"玩家资料错误"
      });
    }

    if (!message || !message.trim()) {
      return res.json({
        success:false,
        msg:"消息不能为空"
      });
    }

    const cleanMsg =
    message
    .trim()
    .slice(0, 80);

    const now = Date.now();

    if (
      chatCooldown[userId] &&
      now - chatCooldown[userId] < 3000
    ) {
      return res.json({
        success:false,
        msg:"请3秒后再发送"
      });
    }

    chatCooldown[userId] = now;

    await supabase
    .from("chat_messages")
    .insert([
      {
        user_id:userId,
        username,
        message:cleanMsg,
        type:"real"
      }
    ]);

    res.json({
      success:true
    });

  } catch (err) {
    console.error("chat send error:", err);
    res.json({
      success:false,
      msg:"发送失败"
    });
  }
});


// ===== LIVE CHAT：读取最近消息 =====
app.get("/chat/list", async (req, res) => {
  try {

    const { data } = await supabase
    .from("chat_messages")
    .select("*")
    .order("id", {
      ascending:false
    })
    .limit(50);

    res.json(
      (data || []).reverse()
    );

  } catch (err) {
    console.error("chat list error:", err);
    res.json([]);
  }
});
// ===== 启动 =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("RUNNING ON", PORT);
});
