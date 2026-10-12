import { createBot } from "./bot.js";
import { authStatus } from "./cloud.js";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";

const config = loadConfig();
const store = new Store(config.dataDir);
const bot = createBot(config, store);

const auth = await authStatus(config.claudeBin);
console.log(`claude login: ${auth.loggedIn ? "yes" : "no"} (${auth.detail})`);
if (auth.warning) console.warn(auth.warning);
if (!auth.loggedIn) console.warn("Run: docker compose exec -it jarvis claude auth login");
if (config.allowedChatId === undefined) console.warn("TELEGRAM_ALLOWED_CHAT_ID unset: setup mode, send /start to the bot.");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void bot.stop());
}

// Long polling: the container only makes outbound calls, so it needs no public URL.
try {
  await bot.start({ onStart: (me) => console.log(`JARVIS online as @${me.username}`) });
} catch (err) {
  const unauthorized = (err as { error_code?: number }).error_code === 401;
  console.error(unauthorized ? "Telegram rejected TELEGRAM_BOT_TOKEN. Check it with @BotFather." : err);
  process.exit(1);
}
