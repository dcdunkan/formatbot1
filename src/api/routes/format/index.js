const url = require('url');
const messages = require('../../../messages/format');
const keyboards = require('./keyboards');
const db = require('../../utils/db');
const logger = require('../../utils/logger');
const { log } = require('../../utils/db');
const ivMaker = require('../../utils/ivMaker');
const puppet = require('../../utils/puppet');
const { validRegex } = require('../../../config/config.json');

const rabbitmq = require('../../../service/rabbitmq');

const group = process.env.TGGROUP;
const fileGroup = process.env.TGFILEGROUP;

const FILESLAVE = process.env.FILESLAVE;
let MAIN_CHAN = '';
let fileSlave = null;

if (FILESLAVE) {
  MAIN_CHAN = process.env.FILESCHAN_DEV || 'files';
  fileSlave = require('./files');
}
const IVMAKINGTIMEOUT = +(process.env.IVMAKINGTIMEOUT || 60);
rabbitmq.createChannel();

const getLinkFromEntity = (entities, txt) => {
  let links = [];
  for (let i = 0; i < entities.length; i += 1) {
    if (entities[i].url) {
      links.push(entities[i].url);
      continue;
    }
    if (entities[i].type === 'url') {
      let checkFf = txt.substr(0, entities[i].length + 1).match(/\[(.*?)\]/);
      if (!checkFf) {
        links.push(txt.substr(entities[i].offset, entities[i].length));
      }
    }
  }
  return links;
};

function getLink(links) {
  let lnk = links[0];
  for (let i = 1; i < links.length; i += 1) {
    if (links[i].startsWith(lnk)) {
      lnk = links[i];
    }
  }
  return lnk;
}

function getAllLinks(text) {
  const urlRegex = /(\b(https?|ftp|file):\/\/[-A-Z0-9+&@#/%?=~_|!:,.;]*[-A-Z0-9+&@#/%=~_|])/ig;
  return text.match(urlRegex) || [];
}

const support = ({ message, reply }, botHelper) => {
  let system = JSON.stringify(message.from);
  try {
    const sup = [
      process.env.SUP_LINK,
      process.env.SUP_LINK1,
      process.env.SUP_LINK2,
      process.env.SUP_LINK3,
    ];
    reply(messages.support(sup), {
      ...keyboards.hide(),
      disable_web_page_preview: true,
    }).catch(e => botHelper.sendError(e));
  } catch (e) {
    system = `${e}${system}`;
  }
  botHelper.sendAdmin(`support ${system}`);
};

const startOrHelp = ({ message, reply }, botHelper) => {
  let system = JSON.stringify(message.from);
  try {
    reply(messages.start(), keyboards.start()).catch(e => botHelper.sendError(e));
  } catch (e) {
    system = `${e}${system}`;
  }
  botHelper.sendAdmin(system);
};
const broadcast = ({ message: msg, reply }, botHelper) => {
  const { chat: { id: chatId }, text } = msg;
  const isAdm = botHelper.isAdmin(chatId);
  if (isAdm) {
    return db.processBroadcast(text, reply, botHelper);
  }
}
module.exports = (bot, botHelper) => {
  bot.command(['/start', '/help'], ctx => startOrHelp(ctx, botHelper));
  bot.command(['/createBroadcast','/startBroadcast'], ctx => broadcast(ctx, botHelper));
  bot.hears('👋 Help', ctx => startOrHelp(ctx, botHelper));
  bot.hears('👍Support', ctx => support(ctx, botHelper));
  bot.command('support', ctx => support(ctx, botHelper));
  bot.hears('⌨️ Hide keyboard', ({ reply }) => {
    reply('Type /help to show.', keyboards.hide()).catch(e => botHelper.sendError(e));
  });

  bot.action(/.*/, async (ctx) => {
    const [data] = ctx.match;
    const s = data === 'no_img';
    if (s) {
      const { message } = ctx.update.callback_query;
      const { message_id, chat, entities } = message;
      const rabbitMes = { message_id, chatId: chat.id, link: entities[1].url };
      await rabbitmq.addToQueue(rabbitMes, rabbitmq.chanPuppet());
      return;
    }
    const resolveDataMatch = data.match(/^r_([0-9]+)_([0-9]+)/);
    if (resolveDataMatch) {
      let [, msgId, userId] = resolveDataMatch;
      const extra = { reply_to_message_id: msgId };
      let error = '';
      try {
        await bot.telegram.sendMessage(userId, messages.resolved(), extra);
      } catch (e) {
        error = JSON.stringify(e);
      }
      const { update: { callback_query } } = ctx;
      const { message: { text, message_id }, from } = callback_query;
      let RESULT = `${text}\nResolved! ${error}`;
      await bot.telegram.editMessageText(from.id, message_id, null, RESULT).
        catch(console.log);
    }
  });

  const addToQueue = async ({ message: msg, reply }) => {
    if (FILESLAVE) {
      return;
    }
    logger(msg);
    let { reply_to_message, entities, caption_entities } = msg;
    if (reply_to_message) return;
    const { chat: { id: chatId }, caption } = msg;
    let { text } = msg;
    const isAdm = botHelper.isAdmin(chatId);
    let rpl = reply_to_message;
    if (msg.document || (rpl && rpl.document)) {
      return;
    }

    if (caption) {
      text = caption;
      if (caption_entities) entities = caption_entities;
    }
    if (msg && text) {
      const force = isAdm && botHelper.checkForce(text);
      let links = getAllLinks(text);
      try {
        let link = links[0];
        if (!link && entities) {
          links = getLinkFromEntity(entities, text);
        }
        link = getLink(links);
        if (!link) return;
        const parsed = url.parse(link);
        if (link.match(/^(https?:\/\/)?(www.)?google/)) {
          const l = link.match(/url=(.*?)($|&)/);
          if (l && l[1]) link = decodeURIComponent(l[1]);
        }
        if (link.match(new RegExp(validRegex))) {
          if (botHelper.db !== false) {
            await log({ link, type: 'return' });
          }
          reply(messages.showIvMessage('', link, link),
            { parse_mode: 'Markdown' }).catch(e => botHelper.sendError(e));
          return;
        }
        if (!parsed.pathname) {
          if (botHelper.db !== false) {
            await log({ link, type: 'nopath' });
          }
          return;
        }
        const res = await reply('Waiting for instantView...').catch(() => {}) ||
          {};
        const message_id = res && res.message_id;
        if (!message_id) throw new Error('blocked');
        const rabbitMes = { message_id, chatId, link };
        if (force) {
          rabbitMes.force = force;
        }
        await rabbitmq.addToQueue(rabbitMes);
      } catch (e) {
        botHelper.sendError(e);
      }
    }
  };
  bot.hears(/.*/, (ctx) => addToQueue(ctx));
  bot.on('message', ({ update, reply }) => addToQueue({ ...update, reply }));

  let browserWs = null;
  if (!botHelper.config.nopuppet && !process.env.NOPUPPET) {
    puppet.getBrowser().then(ws => {
      browserWs = ws;
    });
  }
  const jobMessage = async (task) => {
    const { chatId, message_id: messageId, q, force, document } = task;
    let { link } = task;
    let error = '';
    let isBroken = false;
    let resolveMsgId = false;
    let logGroup = group;
    try {
      let RESULT = '';
      let TITLE = '';
      let isFile = false;
      let linkData = '';
      try {
        logger(`db is ${botHelper.db}`);
        logger(`queue job ${q}`);
        let params = rabbitmq.getParams(q);
        const isAdm = botHelper.isAdmin(chatId);
        if (isAdm) {
          params.isadmin = true;
        }
        if (FILESLAVE) {
          logger(task);
          // await new Promise(resolve => setTimeout(() => resolve(), 120000));
          try {
            const { isHtml, content } = await fileSlave.putFile(task.doc,
              botHelper);
            linkData = await ivMaker.makeIvLinkFromContent(
              { content, isHtml, file_name: task.doc.file_name },
              params);
          } catch (e) {
            error = `${e}`;
            linkData = { error };
            botHelper.sendAdmin(error, process.env.TGGROUPBUGS);
          }
          await rabbitmq.addToQueue(
            { document: linkData, chatId, message_id: messageId });
          return;
        }
        rabbitmq.time(q, true);
        let source = `${link}`;
        if (document) {
          linkData = document;
          logGroup = fileGroup;
          source = 'document';
        } else {
          link = ivMaker.parse(link);
          const { isText, url: baseUrl } = await ivMaker.isText(link, force);
          if (baseUrl !== link) link = baseUrl;
          if (!isText) {
            isFile = true;
          } else {
            if (rabbitmq.isMain(q)) {
              // await new Promise(resolve => setTimeout(() => resolve(), 120000));
            }
            const { hostname } = url.parse(link);
            logger(hostname);
            logger(link);
            if (hostname.match('djvu')) throw 'err';
            if (botHelper.isBlackListed(hostname)) throw 'BlackListed';
            const botParams = botHelper.getParams(hostname, chatId, force);
            params = { ...params, ...botParams };
            params.browserWs = browserWs;
            params.db = botHelper.db !== false;
            logger(params);
            await new Promise(resolve => setTimeout(() => resolve(), 100));
            //linkData = await ivMaker.makeIvLink(link, params);
            const ivTask = ivMaker.makeIvLink(link, params);
            const ivTimer = new Promise((resolve) => {
              setTimeout(resolve, IVMAKINGTIMEOUT * 1000, 'timedOut');
            });
            await Promise.race([ivTimer, ivTask]).then((value) => {
              if (value === 'timedOut') {
                botHelper.sendAdmin(`timedOut ${link}`,
                  process.env.TGGROUPBUGS);
              } else {
                linkData = value;
              }
            });
          }
        }
        if (isFile) {
          RESULT = messages.isLooksLikeFile(link);
        } else {
          if (linkData.error) {
            RESULT = messages.brokenFile(linkData.error);
          } else {
            const { iv, isLong, pages = '', push = '', title = '' } = linkData;
            const longStr = isLong ? `Long ${pages}/${push} ` : '';
            TITLE = `${title}\n`;
            RESULT = messages.showIvMessage(longStr, iv, source);
          }
        }
      } catch (e) {
        logger(e);
        isBroken = true;
        RESULT = messages.broken(link);
        error = `broken ${link} ${e}`;
      }
      let t = rabbitmq.time(q);
      const extra = { parse_mode: 'Markdown' };
      await bot.telegram.editMessageText(chatId, messageId,
        null, `${TITLE}${RESULT}`, extra).catch(() => {});
      if (!error) {
        botHelper.sendAdminMark(`${RESULT}${q ? ` from ${q}` : ''}\n${t}`,
          logGroup).catch(() => {});
      }
    } catch (e) {
      logger(e);
      error = `${link} error: ${JSON.stringify(
        e)} ${e.toString()} ${chatId} ${messageId}`;
    }
    logger(error);
    if (error) {
      if (botHelper.db !== false && !FILESLAVE) {
        await log({ url: link, type: 'error', error });
      }
      if (isBroken && resolveMsgId) {
        botHelper.sendAdminOpts(error,
          keyboards.resolvedBtn(resolveMsgId, chatId));
      } else {
        botHelper.sendAdmin(error, process.env.TGGROUPBUGS);
      }
    }
  };

  try {
    setTimeout(() => {
      rabbitmq.run(jobMessage, MAIN_CHAN);
      rabbitmq.runSecond(jobMessage);
      rabbitmq.runPuppet(jobMessage);
    }, 5000);
  } catch (e) {
    botHelper.sendError(e);
  }
};