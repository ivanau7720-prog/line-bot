const express = require("express");
const line = require("@line/bot-sdk");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// ===== LINE =====
const config = {
  channelAccessToken: process.env.LINE_TOKEN,
  channelSecret: process.env.LINE_SECRET
};
const client = new line.Client(config);

// ===== DB =====
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ===== 游戏状态 =====
let GAME = {
  isBetting: false,
  bets: {},
  history: [],
  groupId: null,
  roundId: Date.now()
};

// ===== 获取LINE名字 =====
async function getProfileName(userId) {
  try {
    const profile = await client.getProfile(userId);
    return profile.displayName;
  } catch {
    return "玩家";
  }
}

// ===== 获取用户 =====
async function getUser(userId) {
  const { data } = await supabase
    .from("players")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (!data) {
    const name = await getProfileName(userId);

    const newUser = {
      user_id: userId,
      balance: 0,
      name: name
    };

    await supabase.from("players").insert([newUser]);
    return newUser;
  }

  return data;
}

// ===== 修改余额 =====
async function changeBalance(userId, amount) {
  const user = await getUser(userId);
  const newBalance = Number(user.balance) + Number(amount);

  await supabase
    .from("players")
    .update({ balance: newBalance })
    .eq("user_id", userId);

  return newBalance;
}

// ===== 路单 =====
function generateRoad() {
  let rows = [];
  let row = [];

  GAME.history.forEach((r, i) => {
    const icon = r === "B" ? "🔴" : r === "P" ? "🔵" : "🟢";
    row.push(icon);

    if ((i + 1) % 6 === 0) {
      rows.push(row.join(" "));
      row = [];
    }
  });

  if (row.length) rows.push(row.join(" "));
  return rows.join("\n");
}

// ===== 广播 =====
async function broadcast(text) {
  if (!GAME.groupId) return;
  await client.pushMessage(GAME.groupId, {
    type: "text",
    text
  });
}

// ===== webhook =====
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events;

    for (const event of events) {
      if (event.type !== "message") continue;
      if (event.message.type !== "text") continue;

      if (event.source.type === "group") {
        GAME.groupId = event.source.groupId;
      }

      const userId = event.source.userId;
      const text = event.message.text.trim().toUpperCase();
      const user = await getUser(userId);

      // ===== 查询余额 =====
      if (text === "/BALANCE") {
        return client.replyMessage(event.replyToken, {
          type: "text",
          text: `💰 余额 ${user.balance}`
        });
      }

      // ===== 排行榜 =====
      if (text === "/RANK") {
        const { data } = await supabase
          .from("players")
          .select("*")
          .order("balance", { ascending: false })
          .limit(10);

        let msg = "🏆 排行榜\n\n";

        data.forEach((p, i) => {
          msg += `${i + 1}. 👤 ${p.name} 💰${p.balance}\n`;
        });

        return client.replyMessage(event.replyToken, {
          type: "text",
          text: msg
        });
      }

      // ===== 开局 =====
      if (text === "/START" && userId === process.env.ADMIN_ID) {
        GAME.isBetting = true;
        GAME.bets = {};
        GAME.roundId = Date.now();

        await broadcast("🟢 开局！请下注（60秒）");

        let time = 60;

        const timer = setInterval(async () => {
          time -= 10;

          if (time <= 0) {
            clearInterval(timer);
            GAME.isBetting = false;
            await broadcast("⛔ 停止下注，等待开奖");
          } else {
            await broadcast(`⏳ 剩余 ${time} 秒`);
          }
        }, 10000);

        continue;
      }

      // ===== 下注 =====
      if (/^[BPT]\d+$/i.test(text)) {
        if (!GAME.isBetting) {
          return client.replyMessage(event.replyToken, {
            type: "text",
            text: "❌ 当前不可下注"
          });
        }

        const side = text[0];
        const amount = Number(text.slice(1));

        if (amount < 100 || amount > 10000) {
          return client.replyMessage(event.replyToken, {
            type: "text",
            text: "下注范围100-10000"
          });
        }

        if (user.balance < amount) {
          return client.replyMessage(event.replyToken, {
            type: "text",
            text: "余额不足"
          });
        }

        await changeBalance(userId, -amount);

        GAME.bets[userId] = { side, amount };

        return client.replyMessage(event.replyToken, {
          type: "text",
          text: `✅ 下注成功\n👤 ${user.name}\n🎯 ${side}\n💰 ${amount}`
        });
      }

      // ===== 开奖 =====
      if (text.startsWith("/RESULT") && userId === process.env.ADMIN_ID) {
        const result = text.split(" ")[1];
        if (!["B", "P", "T"].includes(result)) return;

        GAME.history.push(result);

        let report = `🎯 开奖结果：${result}\n\n👤 玩家结算：\n`;

        for (const uid in GAME.bets) {
          const bet = GAME.bets[uid];
          const userData = await getUser(uid);

          let change = -bet.amount;

          if (bet.side === result) {
            let win = bet.amount;

            if (result === "B") {
              win = bet.amount * 0.95;
            }

            change = win;
            await changeBalance(uid, bet.amount + win);
          }

          report += `👤 ${userData.name} ${change > 0 ? "赢" : "输"} ${Math.abs(Math.floor(change))}\n`;

          // 👉 存下注记录
          await supabase.from("transactions").insert([
            {
              user_id: uid,
              bet: bet.side,
              amount: bet.amount,
              result: result,
              win: change
            }
          ]);
        }

        const road = generateRoad();

        await broadcast(report + "\n📊 路单\n" + road);

        GAME.bets = {};
        return;
      }

      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "OK"
      });
    }

    res.sendStatus(200);
  } catch (err) {
    console.log(err);
    res.sendStatus(500);
  }
});

// ===== 后台网页 =====
app.use(express.urlencoded({ extended: true }));

app.get("/admin", async (req, res) => {
  const { data } = await supabase.from("players").select("*");

  let html = `<h2>玩家列表</h2>`;

  data.forEach(p => {
    html += `
      <div>
        👤 ${p.name} | 🆔 ${p.user_id} | 💰${p.balance}
        <form method="POST" action="/admin/topup">
          <input type="hidden" name="user_id" value="${p.user_id}" />
          <input name="amount" placeholder="金额" />
          <button type="submit">充值/扣分</button>
        </form>
        <hr/>
      </div>
    `;
  });

  // 👉 新增：查看开奖记录
  const { data: logs } = await supabase
    .from("transactions")
    .select("*")
    .order("id", { ascending: false })
    .limit(20);

  html += `<h2>最近游戏记录</h2>`;

  logs.forEach(l => {
    html += `
      <div>
        👤 ${l.user_id} | 🎯 ${l.bet} | 💰${l.amount} | 结果:${l.result} | 输赢:${l.win}
      </div>
    `;
  });

  res.send(html);
});

app.post("/admin/topup", async (req, res) => {
  const user_id = req.body.user_id;
  const amount = Number(req.body.amount);

  await changeBalance(user_id, amount);

  res.redirect("/admin");
});

// ===== 启动 =====
app.listen(process.env.PORT || 3000, () => {
  console.log("running");
});
