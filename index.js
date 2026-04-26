/**
 * ██████╗ ███████╗██╗     ██╗   ██╗    ██████╗  ██████╗ ████████╗
 * ██╔══██╗██╔════╝██║     ██║   ██║    ██╔══██╗██╔═══██╗╚══██╔══╝
 * ██████╔╝█████╗  ██║     ██║   ██║    ██████╔╝██║   ██║   ██║
 * ██╔══██╗██╔══╝  ██║     ██║   ██║    ██╔══██╗██║   ██║   ██║
 * ██████╔╝███████╗███████╗╚██████╔╝    ██████╔╝╚██████╔╝   ██║
 * ╚═════╝ ╚══════╝╚══════╝ ╚═════╝     ╚═════╝  ╚═════╝    ╚═╝
 *
 * Full AI-driven Minecraft bot — answers anything, survives everything.
 * v2 — anti-drown system + robust diamond mining + smart tool management
 */

'use strict'

const mineflayer = require('mineflayer')
const nodeFetchModule = require('node-fetch')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')

const fetchFn = globalThis.fetch || nodeFetchModule?.default || nodeFetchModule

/* ═══════════════════════════════════════════
   CONFIGURATION
═══════════════════════════════════════════ */
const CONFIG = {
  host:     process.env.HOST         || 'SINNED998467.aternos.me',
  port:     Number(process.env.PORT  || 49274),
  username: process.env.USERNAME_MC  || 'geo-slave',
  auth:     process.env.AUTH_MODE    || 'auto',
  owner:    'rip_geopero123',
  maxChatLength: 240,
  maxConvHistory: 8,
  survivalIntervalMs: 1500,   // faster tick for better drowning reaction
  autoEatThreshold: 14,
  fleeHealthThreshold: 5,
  hostileAlertRange: 10,
  itemPickupRange: 12,
  resourceSearchRadii: [96, 160, 224, 320],
  miningSearchDistance: 160,
  // Anti-drown thresholds (air bubbles, 0-300)
  drowningAirThreshold: 200,  // start escaping water below this air level
}

/* ═══════════════════════════════════════════
   STATE
═══════════════════════════════════════════ */
let bot             = null
let mcData          = null
let aiEnabled       = true
let aiBusy          = false
let reconnectTimer  = null
let reconnectCount  = 0
let reconnectPenaltyMs = 0
let econnresetStreak = 0
let activeAuthMode = (CONFIG.auth === 'auto') ? 'offline' : CONFIG.auth

// Timers / intervals
let survivalTimer   = null
let robotTimer      = null
let autoEatTimer    = null
let defendInterval  = null
let drowningEscape  = false   // flag: currently escaping water

// Mode flags
let speedrunActive  = false
let isFollowing     = false
let miningActive    = false   // flag: currently mining (pause survival loop interference)
let dragonActive    = false   // flag: currently fighting the Ender Dragon

// Memory
let deathLocation   = null
let conversationHistory = []
let lastThought     = ''

/* ═══════════════════════════════════════════
   AI — SYSTEM PROMPT + CONTEXT
═══════════════════════════════════════════ */
function buildSystemPrompt () {
  return `You are ${CONFIG.username}, an advanced Minecraft bot with real AI.

You MUST:
1. Answer ANY question accurately: math, history, science, geography, coding, philosophy — anything.
2. Understand natural Minecraft commands and translate them to actions.
3. ALWAYS respond with ONLY valid JSON — no markdown, no backticks, no explanation outside the JSON.

Response schema (strict):
{
  "reply": "<chat message max 200 chars, or empty string if silent>",
  "action": "<action name or null>",
  "args": {}
}

══ AVAILABLE ACTIONS ══
follow_owner                      – follow ${CONFIG.owner}
stop                              – stop all movement/tasks
mine         {blocks:[], count}   – mine block types
craft        {item, count}        – craft item
goto_player  {name}               – walk to a player
goto_coords  {x, y, z}           – walk to coordinates
attack                            – attack nearest hostile
eat                               – eat from inventory
pickup                            – collect nearby drops
build_tower  {height, block}      – build pillar upward
build_house  {size}               – build a small house
smelt        {item, fuel, count}  – smelt in furnace
sleep                             – sleep in nearest bed
equip        {item, slot}         – equip item
drop         {item, count}        – drop item
place        {item}               – place block
find_diamond                      – locate nearest diamond ore and report coordinates
wander                            – explore randomly
dance                             – dance / celebrate
robot_mode                        – idle AI loop
speedrun                          – full early-game speedrun
defend                            – auto-protect owner
stop_defend                       – stop defending
scan                              – look around, report
status                            – HP/food/position report
inventory                         – list items
where_am_i                        – current coordinates
find_player  {name}               – locate a player
back_to_death                     – return to death spot
farm         {crop, count}        – harvest nearby crops
enchant      {item, level}        – enchant at table
run_command  {command}            – run exact server command as chat command (with /)
find_resource {name}              – find nearest resource and report coordinates
mine_resource {name, count}       – find and mine resource blocks
find_dropped {item?}              – locate dropped ground item entities

══ INTELLIGENCE RULES ══
• Math questions ("what is 847 * 23?", "sqrt(256)"): compute, reply with answer, action=null
• History/science/general: answer accurately in reply, action=null
• "Who are you": describe yourself as an AI Minecraft bot
• Minecraft commands: set the right action + brief confirmation in reply
• If unsure, give a helpful reply and set action=null
• Be concise, friendly, witty
• Never hallucinate item names or game mechanics`
}

function buildGameContext () {
  if (!bot?.entity) return 'Bot not yet spawned.'

  const p   = bot.entity.position
  const tod = bot.time?.timeOfDay ?? 0
  const timeStr = tod < 1000 ? 'dawn' : tod < 6000 ? 'morning' : tod < 12000 ? 'afternoon' : tod < 13000 ? 'dusk' : 'night'

  const nearPlayers = Object.values(bot.players)
    .filter(pl => pl.entity && pl.username !== bot.username)
    .map(pl => `${pl.username}(${Math.round(pl.entity.position.distanceTo(p))}m)`)
    .slice(0, 5)

  const nearMobs = Object.values(bot.entities)
    .filter(e => e !== bot.entity && e.position &&
      (isHostileEntity(e) || e.type === 'mob'))
    .map(e => {
      const d = Math.round(e.position.distanceTo(p))
      return `${e.name || e.displayName || 'mob'}(${d}m)`
    })
    .filter(m => !m.startsWith('undefined') && !m.startsWith('null'))
    .slice(0, 6)

  const inv = bot.inventory.items().slice(0, 12)
    .map(i => `${i.count}x${i.name}`).join(', ')

  const lines = [
    `HP:${Math.round(bot.health ?? 20)}/20  Food:${Math.round(bot.food ?? 20)}/20  Time:${timeStr}`,
    `Pos:${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`,
    `Inv: ${inv || 'empty'}`,
  ]
  if (nearPlayers.length) lines.push(`Players: ${nearPlayers.join(', ')}`)
  if (nearMobs.length)    lines.push(`Hostiles: ${nearMobs.join(', ')}`)
  if (deathLocation)      lines.push(`Last death: ${Math.round(deathLocation.x)},${Math.round(deathLocation.y)},${Math.round(deathLocation.z)}`)

  return lines.join('\n')
}

function isHostileEntity (e) {
  if (!e || !e.position) return false
  if (e.type === 'hostile') return true
  const kind = String(e.kind || '').toLowerCase()
  if (kind.includes('hostile')) return true
  const name = String(e.name || e.displayName || '').toLowerCase()
  const hostileNames = [
    'zombie', 'skeleton', 'creeper', 'spider', 'witch', 'slime',
    'enderman', 'drowned', 'phantom', 'pillager', 'vindicator',
    'evoker', 'hoglin', 'zoglin', 'blaze', 'ghast', 'magma_cube'
  ]
  return hostileNames.some(h => name.includes(h))
}

/* ═══════════════════════════════════════════
   AI CALLS
═══════════════════════════════════════════ */
async function askPollinationsJSON (userMessage) {
  const ctxHistory = conversationHistory.slice(-3)
    .map(h => `${h.role}: ${h.content}`).join('\n')

  const fullPrompt =
    buildSystemPrompt() +
    '\n\n══ GAME STATE ══\n' + buildGameContext() +
    (ctxHistory ? '\n\n══ RECENT CHAT ══\n' + ctxHistory : '') +
    `\n\n${CONFIG.owner} says: "${userMessage}"\n\nJSON:`

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12000)

  try {
    const url = `https://text.pollinations.ai/${encodeURIComponent(fullPrompt)}`
    const res  = await fetchFn(url, { signal: controller.signal })
    if (!res.ok) return null

    let raw = (await res.text()).trim()
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) return null

    const json = JSON.parse(match[0])
    if (typeof json.reply !== 'string') return null
    return json
  } catch (e) {
    console.log('[ai/json]', e.message)
    return null
  } finally {
    clearTimeout(timeout)
  }
}

async function askPollinationsPlain (userMessage) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 7000)

  try {
    const prompt = `You are a Minecraft bot named ${CONFIG.username}. Answer in 1-2 sentences. User asks: ${userMessage}`
    const url = `https://text.pollinations.ai/${encodeURIComponent(prompt)}`
    const res  = await fetchFn(url, { signal: controller.signal })
    if (!res.ok) return null
    return (await res.text()).trim() || null
  } catch (e) {
    console.log('[ai/plain]', e.message)
    return null
  } finally {
    clearTimeout(timeout)
  }
}

function isLikelyQuestion (text) {
  const t = text.trim().toLowerCase()
  if (t.endsWith('?')) return true
  return /^(who|what|why|how|when|where|can you|do you|are you|is it|explain|tell me)\b/.test(t)
}

function detectGroundedIntent (text) {
  const t = text.toLowerCase().trim()

  // ── Ender Dragon (highest priority — single keyword) ──
  if (/\b(ender ?dragon|the dragon|fight (the )?dragon|kill (the )?dragon|solo (the )?dragon|end ?fight)\b/.test(t)) {
    return { action: 'fight_dragon' }
  }
  if (/\b(end city|endcity|locate end city|nearest end city)\b/.test(t)) {
    return { action: 'find_end_city' }
  }

  if (/\b(inventory|items|what do you have|what are you carrying)\b/.test(t)) return { action: 'inventory' }
  if (/\b(status|health|hp|food|hunger|stats)\b/.test(t)) return { action: 'status' }
  if (/\b(where are you|your location|coords|coordinates|where r you)\b/.test(t)) return { action: 'where_am_i' }
  if (/\b(where did you die|death location|last death)\b/.test(t)) return { action: 'back_to_death' }
  if (/\b(nearest diamond|find diamond|diamond ore)\b/.test(t)) return { action: 'find_diamond' }
  if (/\b(scan|look around|what do you see|observe)\b/.test(t)) return { action: 'scan' }
  if (/\b(follow me|come to me|follow owner)\b/.test(t)) return { action: 'follow_owner' }
  if (/\b(stop|freeze|cancel)\b/.test(t)) return { action: 'stop' }
  if (/\b(attack|fight|kill mob|defend me|protect me)\b/.test(t)) return { action: 'defend' }
  if (/\b(pick up|pickup|collect drops)\b/.test(t)) return { action: 'pickup' }
  if (/\b(find|where|locate)\b.*\b(dropped|drop|ground item|ground items)\b/.test(t)) {
    const m = t.match(/\b(dropped|drop|ground item|ground items)\s+([a-z0-9_ ]+)\b/)
    if (m && m[2]) {
      const item = m[2].trim().replace(/\s+/g, '_')
      if (item && !/\b(items?|nearby|location|loc)\b/.test(item)) {
        return { action: 'find_dropped', args: { item } }
      }
    }
    return { action: 'find_dropped' }
  }
  if (/\b(eat|consume food)\b/.test(t)) return { action: 'eat' }
  if (/\b(drop|throw)\s+(all|everything|whole inventory|entire inventory)\b/.test(t)) return { action: 'drop_all' }

  const dropMatch = t.match(/\b(drop|throw)\s+([a-z0-9_ ]+)\b/)
  if (dropMatch) {
    const item = dropMatch[2]
      .replace(/\b(all|everything|please|now)\b/g, '')
      .trim()
      .replace(/\s+/g, '_')
    if (item) return { action: 'drop', args: { item, count: 64 } }
  }

  return null
}

function localFallback (text) {
  const t = text.toLowerCase().trim()

  if (/^[\d\s+\-*/().^%sqrtabsfloor]+$/i.test(t) && /\d/.test(t)) {
    try {
      const expr = t
        .replace(/sqrt\(([^)]+)\)/g, (_, n) => Math.sqrt(eval(n)))
        .replace(/abs\(([^)]+)\)/g,  (_, n) => Math.abs(eval(n)))
        .replace(/floor\(([^)]+)\)/g,(_, n) => Math.floor(eval(n)))
        .replace(/\^/g, '**')
      const result = Function('"use strict"; return (' + expr + ')')()
      if (Number.isFinite(result)) return `= ${result}`
    } catch (_) {}
  }

  if (/hello|hi|hey|sup/.test(t))       return `Hey! I'm ${CONFIG.username}. Ask me anything!`
  if (/who are you|what are you/.test(t)) return `I'm ${CONFIG.username}, an AI-powered Minecraft bot. I can answer questions, mine, fight, craft — you name it!`
  if (/\bhelp\b/.test(t))               return 'Ask me anything or say: follow, mine, craft, attack, defend, speedrun, status, inventory'
  if (/thank/.test(t))                  return 'Anytime!'
  if (/bye|cya|goodbye/.test(t))        return 'See you! Staying in the game...'
  return `I heard you: "${text}". (AI offline – try again in a moment)`
}

/* ═══════════════════════════════════════════
   UTILITIES
═══════════════════════════════════════════ */
function safeChat (msg) {
  if (!msg) return
  const text = String(msg).slice(0, CONFIG.maxChatLength)
  if (!bot?._client || typeof bot._client.chat !== 'function') {
    console.log('[chat] (offline):', text)
    return
  }
  try { bot.chat(text) } catch (e) { console.log('[chat] err:', e.message) }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

function stopMovement () {
  if (!bot) return
  try {
    if (typeof bot.clearControlStates === 'function') bot.clearControlStates()
    else ['forward','back','left','right','jump','sprint','sneak']
      .forEach(c => { try { bot.clearControlState(c) } catch (_) {} })
  } catch (_) {}
  if (bot.pathfinder) bot.pathfinder.setGoal(null)
  isFollowing = false
}

function stopAllTasks () {
  stopMovement()
  stopDefend()
  speedrunActive = false
  miningActive = false
  dragonActive = false
  try { bot.deactivateItem() } catch (_) {}
  if (robotTimer) { clearInterval(robotTimer); robotTimer = null }
}

function getMovements () {
  if (!mcData) mcData = require('minecraft-data')(bot.version)
  const m = new Movements(bot, mcData)
  m.canDig       = true
  m.allowParkour = true
  m.allowSprinting = true
  // Allow swimming — bot will pathfind through water
  m.canOpenDoors = true
  return m
}

function nearbyPlayers () {
  return Object.values(bot.players)
    .filter(p => p.entity && p.username !== bot.username)
    .map(p => p.username)
}

function findItem (predicate) {
  return bot.inventory.items().find(predicate)
}

function itemHas (item, keyword) {
  return item?.name?.includes(keyword)
}

/* ═══════════════════════════════════════════
   WATER / DROWNING DETECTION
═══════════════════════════════════════════ */
function isInWater () {
  if (!bot?.entity) return false
  // Check the block at the bot's feet and head
  try {
    const feetBlock = bot.blockAt(bot.entity.position)
    const headBlock = bot.blockAt(bot.entity.position.offset(0, 1, 0))
    const waterNames = ['water', 'flowing_water', 'lava', 'flowing_lava', 'bubble_column', 'kelp', 'seagrass']
    const feetName = feetBlock?.name || ''
    const headName = headBlock?.name || ''
    return waterNames.some(w => feetName.includes(w) || headName.includes(w))
  } catch (_) {
    return false
  }
}

function isSubmerged () {
  if (!bot?.entity) return false
  try {
    const headBlock = bot.blockAt(bot.entity.position.offset(0, 1, 0))
    const waterNames = ['water', 'flowing_water', 'bubble_column']
    return waterNames.some(w => (headBlock?.name || '').includes(w))
  } catch (_) { return false }
}

async function escapeWater () {
  if (drowningEscape) return  // already escaping
  drowningEscape = true
  console.log('[anti-drown] Detected in water — escaping!')

  // Stop current tasks temporarily
  if (bot.pathfinder) bot.pathfinder.setGoal(null)
  stopMovement()

  try {
    // Phase 1: Swim up aggressively
    for (let i = 0; i < 20; i++) {
      if (!isSubmerged()) break
      bot.setControlState('jump', true)
      bot.setControlState('sprint', true)
      await sleep(100)
    }
    bot.setControlState('jump', false)
    bot.setControlState('sprint', false)

    // Phase 2: If still in water, try to pathfind to nearby non-water block
    if (isInWater()) {
      const pos = bot.entity.position
      // Try to find a nearby solid block to stand on
      const offsets = [
        [2, 0, 0], [-2, 0, 0], [0, 0, 2], [0, 0, -2],
        [2, 0, 2], [-2, 0, -2], [2, 0, -2], [-2, 0, 2],
        [0, 2, 0]  // above (shore ledge)
      ]

      let escaped = false
      for (const [dx, dy, dz] of offsets) {
        const target = pos.offset(dx, dy, dz)
        const block = bot.blockAt(target)
        if (block && block.name !== 'water' && block.name !== 'flowing_water') {
          try {
            bot.pathfinder.setMovements(getMovements())
            await bot.pathfinder.goto(new goals.GoalBlock(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z)))
            escaped = true
            break
          } catch (_) {}
        }
      }

      // Phase 3: Emergency — pillar up using any block in inventory
      if (!escaped && isInWater()) {
        const anyBlock = bot.inventory.items()
          .find(i => !['sword','pickaxe','axe','shovel','bow','arrow','food','bucket'].some(k => i.name.includes(k)))
        if (anyBlock) {
          try {
            await bot.equip(anyBlock, 'hand')
            for (let i = 0; i < 5; i++) {
              const ref = bot.blockAt(bot.entity.position.offset(0, -1, 0))
              if (ref && !isInWater()) break
              bot.setControlState('jump', true)
              await sleep(200)
              try { await bot.placeBlock(ref, { x: 0, y: 1, z: 0 }) } catch (_) {}
              bot.setControlState('jump', false)
              await sleep(100)
            }
          } catch (_) {}
        }
      }
    }

    // Wait until clearly out of water
    for (let i = 0; i < 30; i++) {
      if (!isInWater()) break
      bot.setControlState('jump', true)
      await sleep(100)
      bot.setControlState('jump', false)
    }

    console.log('[anti-drown] Escape complete. In water:', isInWater())
  } catch (e) {
    console.log('[anti-drown] Error during escape:', e.message)
  } finally {
    stopMovement()
    drowningEscape = false
  }
}

/* ═══════════════════════════════════════════
   MOVEMENT
═══════════════════════════════════════════ */
async function gotoCoords (x, y, z) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return 'Invalid coords'
  stopAllTasks()
  bot.pathfinder.setMovements(getMovements())
  const fy = Number.isFinite(y) ? y : bot.entity.position.y
  bot.pathfinder.setGoal(new goals.GoalNear(x, fy, z, 1))
  return `Going to ${Math.round(x)},${Math.round(fy)},${Math.round(z)}`
}

async function gotoNear (x, y, z, range = 1) {
  bot.pathfinder.setMovements(getMovements())
  await bot.pathfinder.goto(new goals.GoalNear(x, y, z, range))
}

async function gotoPlayer (name) {
  const target = Object.values(bot.players)
    .find(p => p.username?.toLowerCase() === name.toLowerCase())
  if (!target?.entity) return `Can't see ${name}`
  stopAllTasks()
  bot.pathfinder.setMovements(getMovements())
  bot.pathfinder.setGoal(new goals.GoalFollow(target.entity, 1), false)
  return `Going to ${target.username}`
}

async function followOwner () {
  const player = bot.players[CONFIG.owner]?.entity
  if (!player) return "Can't see you"
  stopAllTasks()
  isFollowing = true
  bot.pathfinder.setMovements(getMovements())
  bot.pathfinder.setGoal(new goals.GoalFollow(player, 1), true)
  return 'Following you'
}

async function wander () {
  stopAllTasks()
  bot.pathfinder.setMovements(getMovements())
  const r = 12
  const x = bot.entity.position.x + Math.random() * r * 2 - r
  const z = bot.entity.position.z + Math.random() * r * 2 - r
  bot.pathfinder.setGoal(new goals.GoalNear(x, bot.entity.position.y, z, 1))
  return 'Wandering...'
}

async function dance () {
  stopMovement()
  for (let i = 0; i < 5; i++) {
    bot.setControlState('jump', true)
    bot.setControlState(i % 2 === 0 ? 'left' : 'right', true)
    await bot.look((bot.entity?.yaw || 0) + (Math.PI / 2) * i, -0.3, true)
    await sleep(280)
    stopMovement()
    await sleep(120)
  }
  return 'Dance complete!'
}

function whereAmI () {
  if (!bot?.entity) return "Still loading..."
  const p = bot.entity.position
  return `I'm at ${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}`
}

function whereIsPlayer (name) {
  const target = Object.values(bot.players)
    .find(p => p.username?.toLowerCase() === name.toLowerCase())
  if (!target) return `I don't know ${name}`
  if (!target.entity) return `${target.username} isn't visible to me`
  const d = Math.round(target.entity.position.distanceTo(bot.entity.position))
  const pp = target.entity.position
  return `${target.username} is at ${Math.round(pp.x)},${Math.round(pp.y)},${Math.round(pp.z)} (${d}m away)`
}

async function backToDeath () {
  if (!deathLocation) return 'No death location recorded'
  return gotoCoords(deathLocation.x, deathLocation.y, deathLocation.z)
}

/* ═══════════════════════════════════════════
   PERCEPTION
═══════════════════════════════════════════ */
async function scanAround () {
  if (!bot?.entity) return "Can't scan yet"
  const startYaw = bot.entity.yaw || 0
  for (let i = 0; i < 8; i++) {
    await bot.look(startYaw + (Math.PI / 4) * i, i % 2 === 0 ? -0.2 : 0.15, true)
    await sleep(320)
  }
  const players = nearbyPlayers()
  return players.length ? `I see: ${players.join(', ')}` : 'No players nearby'
}

function statusReport () {
  if (!bot?.entity) return 'Loading...'
  const p = bot.entity.position
  const players = nearbyPlayers()
  return [
    `HP ${Math.round(bot.health ?? 0)}`,
    `food ${Math.round(bot.food ?? 0)}`,
    `pos ${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`,
    players.length ? `near: ${players.join(', ')}` : 'alone'
  ].join(' | ')
}

function inventoryReport () {
  const items = bot.inventory.items().slice(0, 10)
    .map(i => `${i.count}x${i.name}`)
  return items.length ? items.join(', ') : 'Inventory empty'
}

/* ═══════════════════════════════════════════
   TOOL MANAGEMENT
═══════════════════════════════════════════ */
function hasTool (type = 'pickaxe', minTier = 'wooden') {
  const tiers = ['netherite', 'diamond', 'iron', 'stone', 'wooden']
  const minIdx = tiers.indexOf(minTier)
  return bot.inventory.items().some(i => {
    if (!i.name.includes(type)) return false
    const tierIdx = tiers.findIndex(t => i.name.startsWith(t))
    return tierIdx !== -1 && tierIdx <= minIdx
  })
}

/**
 * Ensure the bot has at least an iron pickaxe before mining diamonds.
 * Will attempt to craft one if materials exist.
 */
async function ensurePickaxeForDiamonds () {
  if (hasTool('pickaxe', 'iron')) return { ok: true }

  // Check if we can craft iron pickaxe (need 3 iron ingots + 2 sticks)
  const ironCount = bot.inventory.items()
    .filter(i => i.name === 'iron_ingot')
    .reduce((s, i) => s + i.count, 0)
  const stickCount = bot.inventory.items()
    .filter(i => i.name === 'stick')
    .reduce((s, i) => s + i.count, 0)

  if (ironCount >= 3 && stickCount >= 2) {
    const result = await craftItem('iron_pickaxe', 1)
    if (result.includes('Crafted')) return { ok: true }
  }

  // Try stone pickaxe
  if (hasTool('pickaxe', 'stone')) return { ok: true }

  const stoneCount = bot.inventory.items()
    .filter(i => i.name === 'cobblestone' || i.name === 'stone')
    .reduce((s, i) => s + i.count, 0)

  if (stoneCount >= 3) {
    // Make sure we have sticks
    let currentSticks = bot.inventory.items()
      .filter(i => i.name === 'stick')
      .reduce((s, i) => s + i.count, 0)

    if (currentSticks < 2) {
      // Try to get planks first
      const planks = bot.inventory.items()
        .filter(i => i.name.endsWith('_planks'))
        .reduce((s, i) => s + i.count, 0)
      if (planks >= 2) {
        await craftItem('stick', 4)
      }
    }

    if (hasTool('pickaxe', 'wooden')) {
      // Just use wooden for stone mining at least
    } else {
      const result = await craftItem('stone_pickaxe', 1)
      if (result.includes('Crafted')) return { ok: true }
    }
  }

  if (hasTool('pickaxe', 'wooden')) return { ok: true, warn: 'Only wooden pickaxe — diamonds require iron+' }

  return { ok: false, reason: 'No pickaxe available. Need iron or stone pickaxe to mine diamonds.' }
}

function bestPickaxe () {
  if (!mcData) mcData = require('minecraft-data')(bot.version)
  const tiers = ['netherite', 'diamond', 'iron', 'stone', 'wooden']
  for (const t of tiers) {
    const found = bot.inventory.items().find(i => i.name === `${t}_pickaxe`)
    if (found) return found
  }
  return null
}

function bestTool (block) {
  const items = bot.inventory.items()
  const tiers = ['netherite', 'diamond', 'iron', 'stone', 'wooden']
  const kinds = ['pickaxe', 'axe', 'shovel', 'hoe']
  for (const k of kinds) for (const t of tiers) {
    const found = items.find(i => i.name.includes(`${t}_${k}`))
    if (found) return found
  }
  return null
}

/* ═══════════════════════════════════════════
   MINING + BLOCKS
═══════════════════════════════════════════ */
function findBlock (names, maxDist = 48) {
  if (!mcData) mcData = require('minecraft-data')(bot.version)
  const ids = names.map(n => mcData.blocksByName[n]?.id).filter(id => typeof id === 'number')
  if (!ids.length) return null
  return bot.findBlock({ matching: ids, maxDistance: maxDist })
}

/**
 * Try multiple approach positions around a block to find one that's reachable.
 * This solves the "can't reach" issue by not giving up on the first failure.
 */
async function approachBlock (block, range = 3) {
  const bp = block.position
  bot.pathfinder.setMovements(getMovements())

  // Fast strategy: a couple of GoalNear tries only (avoid slow exhaustive routing).
  let reached = false
  for (const r of [2, 3, 4]) {
    try {
      await bot.pathfinder.goto(new goals.GoalNear(bp.x, bp.y, bp.z, r))
      reached = true
      break
    } catch (_) {}
  }

  if (!reached) reached = bot.entity.position.distanceTo(bp) <= 5

  // CRITICAL: fully stop the bot before digging so it doesn't drift mid-swing.
  try { bot.pathfinder.setGoal(null) } catch (_) {}
  try {
    if (typeof bot.clearControlStates === 'function') bot.clearControlStates()
    else ['forward','back','left','right','jump','sprint','sneak']
      .forEach(c => { try { bot.clearControlState(c) } catch (_) {} })
  } catch (_) {}

  return reached
}

/**
 * Safely dig a block: stop in-progress digs, refresh block, settle motion,
 * then dig. This prevents the "glitch on final block" issue where another
 * action (auto-eat, pathfinder) interrupts the swing right before completion.
 */
async function safeDig (block, opts = {}) {
  if (!block) return { ok: false, reason: 'No block' }
  const { holdTool = true } = opts

  // 1. Cancel any in-progress dig (mineflayer locks otherwise).
  if (bot.targetDigBlock) {
    try { await bot.stopDigging() } catch (_) {}
  }

  // 2. Make sure the bot is not moving / not pathing.
  try { bot.pathfinder.setGoal(null) } catch (_) {}
  try {
    if (typeof bot.clearControlStates === 'function') bot.clearControlStates()
    else ['forward','back','left','right','jump','sprint','sneak']
      .forEach(c => { try { bot.clearControlState(c) } catch (_) {} })
  } catch (_) {}

  // 3. Refresh block reference from world (it may have changed since we found it).
  const fresh = bot.blockAt(block.position)
  if (!fresh || fresh.name === 'air' || fresh.name === 'cave_air' || fresh.name === 'void_air') {
    return { ok: true, alreadyGone: true }
  }
  // If a different block now occupies the position, treat as failure (don't grief).
  if (block.name && fresh.name !== block.name) {
    return { ok: false, reason: `Block changed (${fresh.name})` }
  }
  block = fresh

  // 4. Equip best tool right before the swing.
  if (holdTool) {
    const tool = bestTool(block)
    if (tool && bot.heldItem?.name !== tool.name) {
      try { await bot.equip(tool, 'hand') } catch (_) {}
    }
  }

  // 5. Look at the block, small settle delay so the server registers position.
  try { await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true) } catch (_) {}
  await sleep(80)

  // 6. Dig — and DO NOT let anything cancel it. If equip is needed mid-dig,
  // mineflayer auto-aborts; we keep miningActive=true so survival loop skips equips.
  try {
    await bot.dig(block)
    return { ok: true }
  } catch (e) {
    // Some servers report "Block is already broken" — count as success.
    const msg = String(e?.message || e)
    if (/already broken|not currently digging|stopped digging/i.test(msg)) {
      return { ok: true, alreadyGone: true }
    }
    return { ok: false, reason: msg }
  }
}

/**
 * Clear obstructing blocks between bot and target block so we can reach it.
 * Digs away non-ore blocks in the path.
 */
async function clearPathToBlock (targetBlock) {
  const tp = targetBlock.position
  const bp = bot.entity.position

  // Vector from bot to block
  const dx = tp.x - bp.x
  const dy = tp.y - bp.y
  const dz = tp.z - bp.z
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)

  const steps = Math.ceil(dist)
  const skipNames = ['diamond_ore', 'deepslate_diamond_ore', 'bedrock']

  for (let i = 1; i < steps; i++) {
    const t = i / steps
    const cx = Math.round(bp.x + dx * t)
    const cy = Math.round(bp.y + 1 + dy * t)  // +1 for head height
    const cz = Math.round(bp.z + dz * t)

    const b = bot.blockAt({ x: cx, y: cy, z: cz })
    if (!b || b.name === 'air' || skipNames.includes(b.name)) continue

    // Dig this obstruction
    if (typeof bot.canDigBlock === 'function' && !bot.canDigBlock(b)) continue
    const res = await safeDig(b)
    if (res.ok) await sleep(80)
  }
}

async function mineBlocks (blockNames, count = 1) {
  if (!Array.isArray(blockNames)) blockNames = [blockNames]
  let mined = 0
  miningActive = true
  try {
    for (let i = 0; i < count; i++) {
      const block = findBlock(blockNames, CONFIG.miningSearchDistance)
      if (!block) break
      const reached = await approachBlock(block, 3)
      if (!reached) break
      const res = await safeDig(block)
      if (!res.ok) break
      mined++
      await sleep(120)
    }
  } finally {
    miningActive = false
  }
  return mined
}

/**
 * IMPROVED: Mine an exact block with multi-strategy approach + path clearing.
 * Uses safeDig() so the swing isn't interrupted by survival/auto-eat/pathfinder.
 */
async function mineExactBlock (block) {
  if (!block) return { ok: false, reason: 'No block provided' }

  miningActive = true
  try {
    const tool = bestTool(block)
    if (tool) { try { await bot.equip(tool, 'hand') } catch (_) {} }

    let reached = await approachBlock(block, 3)
    if (!reached) reached = await approachBlock(block, 4)

    const dist = bot.entity.position.distanceTo(block.position)
    if (!reached && dist > 6) {
      return { ok: false, reason: `Could not reach block at ${Math.round(block.position.x)},${Math.round(block.position.y)},${Math.round(block.position.z)} (${Math.round(dist)}m away)` }
    }

    if (typeof bot.canDigBlock === 'function' && !bot.canDigBlock(block)) {
      return { ok: false, reason: 'Cannot dig this block (protection or tool mismatch)' }
    }

    // Try up to 3 times — refresh ref each retry so we never dig stale blocks.
    let lastReason = null
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await safeDig(block)
      if (res.ok) return { ok: true }
      lastReason = res.reason

      // If interrupted, re-approach quickly and try once more.
      await approachBlock(block, 2)
      await sleep(150)
    }
    return { ok: false, reason: lastReason || 'Dig failed after 3 attempts' }
  } finally {
    miningActive = false
  }
}

function findNearestDiamond () {
  if (!mcData) mcData = require('minecraft-data')(bot.version)
  if (!bot?.entity) return 'Bot not spawned yet'

  const ids = [
    mcData.blocksByName.diamond_ore?.id,
    mcData.blocksByName.deepslate_diamond_ore?.id
  ].filter(id => typeof id === 'number')

  if (!ids.length) return 'Diamond ore is unavailable in this game version'

  const block = bot.findBlock({ matching: ids, maxDistance: 128 })
  if (!block) return 'No diamond ore found within 128 blocks'

  const p = block.position
  const dist = Math.round(p.distanceTo(bot.entity.position))
  return `Nearest diamond ore: ${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)} (${dist}m away)`
}

const RESOURCE_ALIASES = {
  diamond: ['diamond_ore', 'deepslate_diamond_ore'],
  diamonds: ['diamond_ore', 'deepslate_diamond_ore'],
  iron: ['iron_ore', 'deepslate_iron_ore'],
  gold: ['gold_ore', 'deepslate_gold_ore'],
  coal: ['coal_ore', 'deepslate_coal_ore'],
  emerald: ['emerald_ore', 'deepslate_emerald_ore'],
  redstone: ['redstone_ore', 'deepslate_redstone_ore'],
  lapis: ['lapis_ore', 'deepslate_lapis_ore'],
  copper: ['copper_ore', 'deepslate_copper_ore'],
  quartz: ['nether_quartz_ore'],
  ancient_debris: ['ancient_debris'],
  wood: ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'dark_oak_log', 'acacia_log', 'mangrove_log', 'cherry_log'],
  logs: ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'dark_oak_log', 'acacia_log', 'mangrove_log', 'cherry_log'],
  stone: ['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate']
}

function resolveResourceBlocks (name) {
  if (!name) return null
  const key = String(name).toLowerCase().replace(/^\./, '').trim()
  if (RESOURCE_ALIASES[key]) return RESOURCE_ALIASES[key]
  return [key]
}

function findNearestResource (name, maxDistance = 128) {
  if (!mcData) mcData = require('minecraft-data')(bot.version)
  if (!bot?.entity) return { error: 'Bot not spawned yet' }

  const blocks = resolveResourceBlocks(name)
  const ids = blocks
    .map(block => mcData.blocksByName[block]?.id)
    .filter(id => typeof id === 'number')

  if (!ids.length) return { error: `Unknown resource: ${name}` }

  const radii = [...new Set([maxDistance, ...(CONFIG.resourceSearchRadii || [])])]
    .filter(r => Number.isFinite(r) && r > 0)
    .sort((a, b) => a - b)

  let block = null
  let usedRadius = maxDistance
  for (const r of radii) {
    block = bot.findBlock({ matching: ids, maxDistance: r })
    if (block) {
      usedRadius = r
      break
    }
  }

  if (!block) {
    const widest = radii[radii.length - 1] || maxDistance
    return { error: `No ${name} found within ${widest} blocks` }
  }

  return { block, blocks, radius: usedRadius }
}

function findNearestResourceMessage (name) {
  const found = findNearestResource(name)
  if (found.error) return found.error

  const p = found.block.position
  const dist = Math.round(p.distanceTo(bot.entity.position))
  return `Nearest ${name}: ${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)} (${dist}m away)`
}

/**
 * IMPROVED: Mine resource with full pre-flight checks + robust approach logic.
 * Handles: tool verification, water escape, multi-attempt digging, path clearing.
 */
async function mineResourceByName (name, count = 1) {
  miningActive = true

  try {
    // ── Pre-flight: escape water first ──
    if (isInWater()) {
      safeChat('In water — escaping first...')
      await escapeWater()
      await sleep(500)
    }

    // ── Pre-flight: tool check ──
    const isDiamond = name.toLowerCase().includes('diamond')
    if (isDiamond) {
      const toolCheck = await ensurePickaxeForDiamonds()
      if (!toolCheck.ok) {
        miningActive = false
        return `Need iron pickaxe for diamonds. ${toolCheck.reason || 'Mine iron first!'}`
      }
      if (toolCheck.warn) safeChat(toolCheck.warn)
    } else {
      // For non-diamonds, just check we have any pickaxe
      if (!hasTool('pickaxe', 'wooden')) {
        safeChat('No pickaxe! Crafting one...')
        await craftItem('wooden_pickaxe', 1).catch(() => {})
        if (!hasTool('pickaxe', 'wooden')) {
          miningActive = false
          return 'No pickaxe available. Craft one first!'
        }
      }
    }

    const found = findNearestResource(name, CONFIG.resourceSearchRadii?.[0] || 96)
    if (found.error) {
      miningActive = false
      return found.error
    }

    const p = found.block.position
    const dist = Math.round(p.distanceTo(bot.entity.position))
    safeChat(`Found ${name} at ${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)} (${dist}m, scan ${found.radius}m). Going there...`)

    // Equip pickaxe BEFORE moving
    const pick = bestPickaxe()
    if (pick) {
      try { await bot.equip(pick, 'hand') } catch (_) {}
    }

    // Mine first block using robust approach
    const first = await mineExactBlock(found.block)

    if (!first.ok) {
      // Try to find another nearby ore of same type
      safeChat(`First attempt failed (${first.reason}). Looking for another...`)
      await sleep(300)

      let mined = 0
      for (let attempt = 0; attempt < 3 && mined === 0; attempt++) {
        const retry = findNearestResource(name)
        if (retry.error) break
        const retryResult = await mineExactBlock(retry.block)
        if (retryResult.ok) { mined = 1; break }
        await sleep(500)
      }

      if (mined === 0) {
        miningActive = false
        return `Could not mine ${name}: ${first.reason}`
      }

      // Mine additional count
      if (count > 1) {
        mined += await mineBlocks(found.blocks, count - 1)
      }

      miningActive = false
      return `Finished mining ${name}. Mined ${mined} block(s).`
    }

    let mined = 1

    // Mine additional blocks if requested
    if (count > 1) {
      mined += await mineBlocks(found.blocks, count - 1)
    }

    miningActive = false

    // Collect drops after mining
    await sleep(300)
    await pickupNearbyItems().catch(() => {})

    return `Finished mining ${name}. Mined ${mined} block(s). Picking up drops...`

  } catch (e) {
    miningActive = false
    return `Mining error: ${e.message.slice(0, 80)}`
  }
}

async function buildTower (height = 5, blockName = 'dirt') {
  let item = findItem(i => itemHas(i, blockName))
    || findItem(i => i.name.endsWith('_planks'))
    || findItem(i => i.name === 'cobblestone')
    || findItem(i => i.name === 'dirt')
  if (!item) return "No blocks to build with"
  await bot.equip(item, 'hand')
  for (let i = 0; i < height; i++) {
    const ref = bot.blockAt(bot.entity.position.offset(0, -1, 0))
    if (!ref) break
    bot.setControlState('jump', true)
    await sleep(220)
    try { await bot.placeBlock(ref, { x: 0, y: 1, z: 0 }) } catch (_) {}
    bot.setControlState('jump', false)
    await sleep(130)
  }
  return `Built ${height}-block tower`
}

async function buildHouse (size = 5) {
  safeChat('Building a house...')
  const startPos = bot.entity.position.floored().offset(1, 0, 0)
  let placed = 0
  const wallBlock = findItem(i => i.name.endsWith('_planks') || i.name === 'cobblestone')
  if (!wallBlock) return "No building material in inventory"
  await bot.equip(wallBlock, 'hand')

  for (let x = 0; x < size; x++) {
    for (let z = 0; z < size; z++) {
      if (x === 0 || x === size - 1 || z === 0 || z === size - 1) {
        for (let y = 0; y < 3; y++) {
          const target = startPos.offset(x, y, z)
          const ref = bot.blockAt(target.offset(0, -1, 0))
          if (!ref) continue
          try {
            await gotoNear(target.x, target.y, target.z, 2)
            await bot.placeBlock(ref, { x: 0, y: 1, z: 0 })
            placed++
          } catch (_) {}
          await sleep(80)
        }
      }
    }
  }
  return `House built (${placed} blocks placed)`
}

async function placeBlockNearby (itemName) {
  const item = findItem(i => itemHas(i, itemName))
  if (!item) return `No ${itemName} in inventory`
  await bot.equip(item, 'hand')
  const ref = bot.blockAt(bot.entity.position.offset(0, -1, 0))
  if (!ref) return 'No surface to place on'
  try {
    await bot.placeBlock(ref, { x: 0, y: 1, z: 0 })
    return `Placed ${item.name}`
  } catch (e) {
    return `Place failed: ${e.message}`
  }
}

/* ═══════════════════════════════════════════
   CRAFTING
═══════════════════════════════════════════ */
async function craftItem (itemName, count = 1) {
  if (!mcData) mcData = require('minecraft-data')(bot.version)
  const def = mcData.itemsByName[itemName]
  if (!def) return `Unknown item: ${itemName}`

  let table = null
  let recipes = bot.recipesFor(def.id, null, 1, null)

  if (!recipes.length) {
    table = bot.findBlock({ matching: mcData.blocksByName.crafting_table?.id, maxDistance: 16 })
    if (!table) return `Need a crafting table for ${itemName}`
    try { await gotoNear(table.position.x, table.position.y, table.position.z, 1) } catch (_) {}
    recipes = bot.recipesFor(def.id, null, 1, table)
  }

  if (!recipes.length) return `No recipe for ${itemName}`

  try {
    await bot.craft(recipes[0], count, table || undefined)
    return `Crafted ${count}x ${itemName}`
  } catch (e) {
    return `Craft failed: ${e.message}`
  }
}

/* ═══════════════════════════════════════════
   SMELTING
═══════════════════════════════════════════ */
async function smeltItems (itemName, fuelName = 'coal', count = 4) {
  if (!mcData) mcData = require('minecraft-data')(bot.version)

  let furnaceBlock = bot.findBlock({
    matching: mcData.blocksByName.furnace?.id,
    maxDistance: 16
  })

  if (!furnaceBlock) {
    const furnaceItem = findItem(i => i.name === 'furnace')
    if (!furnaceItem) return 'No furnace nearby or in inventory'
    await bot.equip(furnaceItem, 'hand')
    const ref = bot.blockAt(bot.entity.position.offset(1, -1, 0))
    if (!ref) return 'Nowhere to place furnace'
    try {
      await bot.placeBlock(ref, { x: 0, y: 1, z: 0 })
      await sleep(500)
      furnaceBlock = bot.findBlock({ matching: mcData.blocksByName.furnace?.id, maxDistance: 4 })
    } catch (e) {
      return `Couldn't place furnace: ${e.message}`
    }
  }

  if (!furnaceBlock) return 'Furnace not found'

  try {
    await gotoNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 1)
    const furnace = await bot.openFurnace(furnaceBlock)

    const inputItem = findItem(i => itemHas(i, itemName))
    const fuelItem  = findItem(i => itemHas(i, fuelName))

    if (!inputItem) { furnace.close(); return `No ${itemName} to smelt` }
    if (!fuelItem)  { furnace.close(); return `No ${fuelName} for fuel` }

    await furnace.putInput(inputItem.type, null, Math.min(count, inputItem.count))
    await furnace.putFuel(fuelItem.type, null, Math.min(count, fuelItem.count))

    safeChat(`Smelting ${count}x ${itemName}...`)
    await sleep(count * 10000)
    await furnace.takeOutput()
    furnace.close()
    return `Smelted ${count}x ${itemName}`
  } catch (e) {
    return `Smelt failed: ${e.message}`
  }
}

/* ═══════════════════════════════════════════
   SLEEP
═══════════════════════════════════════════ */
async function sleepInBed () {
  if (!mcData) mcData = require('minecraft-data')(bot.version)

  const bedIds = Object.values(mcData.blocks)
    .filter(b => b.name.endsWith('_bed'))
    .map(b => b.id)

  const bed = bot.findBlock({ matching: bedIds, maxDistance: 32 })
  if (!bed) return 'No bed nearby'

  try {
    await gotoNear(bed.position.x, bed.position.y, bed.position.z, 1)
    await bot.sleep(bed)
    return 'Sleeping...'
  } catch (e) {
    return `Sleep failed: ${e.message}`
  }
}

function runServerCommand (rawCommand) {
  if (!rawCommand) return 'No command provided'
  if (!bot?._client || typeof bot._client.chat !== 'function') return 'Bot is not ready to send commands'

  const trimmed = String(rawCommand).trim()
  if (!trimmed) return 'No command provided'

  const command = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  try {
    bot.chat(command)
    return `Ran command: ${command}`
  } catch (e) {
    return `Command failed: ${e.message}`
  }
}

function findNearestEndCitySignature (maxDistance = 256) {
  if (!mcData) mcData = require('minecraft-data')(bot.version)
  if (!bot?.entity) return null

  // Strong End City signature blocks. Purpur + end_stone_bricks is usually enough.
  const signatureNames = [
    'purpur_block',
    'purpur_pillar',
    'purpur_stairs',
    'end_stone_bricks',
    'end_rod'
  ]

  const ids = signatureNames
    .map(n => mcData.blocksByName[n]?.id)
    .filter(id => typeof id === 'number')

  if (!ids.length) return null

  let nearest = null
  let nearestDist = Infinity
  for (const id of ids) {
    const block = bot.findBlock({ matching: id, maxDistance })
    if (!block) continue
    const d = block.position.distanceTo(bot.entity.position)
    if (d < nearestDist) {
      nearest = block
      nearestDist = d
    }
  }
  return nearest
}

function locateEndCity () {
  if (!bot?.entity) return 'Bot not spawned yet'
  const dim = String(bot.game?.dimension || '').toLowerCase()
  if (!dim.includes('end')) {
    return `I need to be in The End first (current: ${bot.game?.dimension || 'unknown'})`
  }

  // No-perms mode: scan loaded chunks for End City signature blocks.
  // (Without /locate perms, exact world-wide nearest city is impossible.)
  for (const radius of [96, 160, 256, 384]) {
    const cityBlock = findNearestEndCitySignature(radius)
    if (!cityBlock) continue

    const p = cityBlock.position
    const d = Math.round(p.distanceTo(bot.entity.position))
    return `Nearest detected End City block at ${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)} (${d}m).`
  }

  const bp = bot.entity.position
  const x = Math.round(bp.x)
  const z = Math.round(bp.z)
  return `No End City detected in loaded chunks. Move/fly through outer End islands and run .city again (current ${x}, ${z}).`
}

/* ═══════════════════════════════════════════
   FARMING
═══════════════════════════════════════════ */
async function farmCrops (cropName = 'wheat', count = 8) {
  if (!mcData) mcData = require('minecraft-data')(bot.version)

  const cropBlock = mcData.blocksByName[cropName]
  if (!cropBlock) return `Unknown crop: ${cropName}`

  let harvested = 0
  for (let i = 0; i < count; i++) {
    const block = bot.findBlock({
      matching: cropBlock.id,
      maxDistance: 32,
      useExtraInfo: b => b.metadata === 7
    })
    if (!block) break
    try {
      await gotoNear(block.position.x, block.position.y, block.position.z, 1)
      const res = await safeDig(block)
      if (res.ok) harvested++
      await sleep(200)
    } catch (_) {}
  }
  return `Harvested ${harvested}x ${cropName}`
}

/* ═══════════════════════════════════════════
   COMBAT
═══════════════════════════════════════════ */
function findEntity (filter, maxDist = 20) {
  let best = null, bestDist = maxDist
  for (const id in bot.entities) {
    const e = bot.entities[id]
    if (e === bot.entity || !filter(e)) continue
    const d = e.position.distanceTo(bot.entity.position)
    if (d < bestDist) { best = e; bestDist = d }
  }
  return best
}

function bestSword () {
  const tiers = ['netherite', 'diamond', 'iron', 'stone', 'wooden']
  for (const t of tiers) {
    const s = findItem(i => i.name.includes(`${t}_sword`))
    if (s) return s
  }
  return null
}

async function equipBestGear () {
  const sword = bestSword()
  if (sword) { try { await bot.equip(sword, 'hand') } catch (_) {} }
}

async function attackNearest () {
  const target = findEntity(e =>
    isHostileEntity(e) || e.type === 'mob'
  , 20)

  if (!target) return 'No mobs in range'
  await equipBestGear()
  try { await gotoNear(target.position.x, target.position.y, target.position.z, 2) } catch (_) {}
  bot.attack(target)
  return `Attacking ${target.name || target.displayName || 'mob'}`
}

function startDefend () {
  if (defendInterval) return 'Already defending'
  defendInterval = setInterval(async () => {
    const ownerEnt = bot.players[CONFIG.owner]?.entity
    if (!ownerEnt) return

    const hostile = findEntity(e => {
      if (e === ownerEnt) return false
      return isHostileEntity(e) && e.position.distanceTo(ownerEnt.position) < 14
    }, 18)

    if (!hostile) return
    await equipBestGear()
    try { await gotoNear(hostile.position.x, hostile.position.y, hostile.position.z, 2) } catch (_) {}
    try { bot.attack(hostile) } catch (_) {}
  }, 1400)

  return 'Defending you!'
}

function stopDefend () {
  if (!defendInterval) return
  clearInterval(defendInterval)
  defendInterval = null
}

/* ═══════════════════════════════════════════
   ENDER DRAGON FIGHT (bow + arrows)
═══════════════════════════════════════════ */
function bestBow () {
  return bot.inventory.items().find(i => i.name === 'bow' || i.name === 'crossbow')
}

function arrowCount () {
  return bot.inventory.items()
    .filter(i => i.name === 'arrow' || i.name === 'tipped_arrow' || i.name === 'spectral_arrow')
    .reduce((s, i) => s + i.count, 0)
}

function findDragon () {
  return Object.values(bot.entities).find(e => {
    if (!e) return false
    const n = (e.name || '').toLowerCase()
    const d = (e.displayName || '').toLowerCase()
    return n === 'ender_dragon' || n === 'enderdragon' || d.includes('ender dragon')
  })
}

function findEndCrystals () {
  if (!bot?.entity) return []
  return Object.values(bot.entities)
    .filter(e => {
      if (!e) return false
      const n = (e.name || '').toLowerCase()
      const d = (e.displayName || '').toLowerCase()
      return n === 'end_crystal' || n === 'ender_crystal' || n === 'endercrystal' || d.includes('end crystal')
    })
    .sort((a, b) =>
      bot.entity.position.distanceTo(a.position) -
      bot.entity.position.distanceTo(b.position))
}

/**
 * Aim at a point in the world with arrow-drop compensation.
 * Full-charge bow gives ~v=3 b/tick; gravity ~0.05 b/tick² → drop ≈ d²/360.
 */
async function aimAtPoint (target) {
  const bp = bot.entity.position.offset(0, bot.entity.height ?? 1.62, 0)
  const dx = target.x - bp.x
  const dz = target.z - bp.z
  const flatDist = Math.sqrt(dx * dx + dz * dz)
  const drop = (flatDist * flatDist) / 360
  try {
    const aim = { x: target.x, y: target.y + drop, z: target.z }
    await bot.lookAt(aim, true)
  } catch (_) {}
}

/**
 * Aim at an entity with optional movement lead.
 */
async function aimAtEntity (e, leadTicks = 0) {
  if (!e?.position) return
  const center = {
    x: e.position.x,
    y: e.position.y + (e.height ? e.height / 2 : 0.5),
    z: e.position.z
  }
  if (leadTicks && e.velocity) {
    center.x += (e.velocity.x || 0) * leadTicks
    center.y += (e.velocity.y || 0) * leadTicks
    center.z += (e.velocity.z || 0) * leadTicks
  }
  await aimAtPoint(center)
}

async function chargeAndFire (chargeMs = 1100) {
  try { bot.activateItem() } catch (_) {}
  await sleep(chargeMs)
  try { bot.deactivateItem() } catch (_) {}
}

/**
 * Detects if the dragon is in its "perch" state — sitting on top of the
 * exit portal. This is the best damage window: stationary, close to origin,
 * head exposed downward. We treat it as the highest-priority target.
 */
function isDragonPerched (dragon) {
  if (!dragon?.position) return false
  const xz = Math.sqrt(dragon.position.x ** 2 + dragon.position.z ** 2)
  const v = dragon.velocity || { x: 0, y: 0, z: 0 }
  const speed = Math.sqrt((v.x || 0) ** 2 + (v.y || 0) ** 2 + (v.z || 0) ** 2)
  // Perched: within ~10 blocks of origin XZ, low altitude, almost no movement.
  return xz < 12 && dragon.position.y < 80 && speed < 0.15
}

/**
 * Solo the Ender Dragon with bow + arrows.
 * Strategy:
 *   1. Pick off End Crystals one by one (they heal the dragon).
 *   2. Once all reachable crystals are gone, snipe the dragon.
 *   3. Eat & strafe between shots; bail if HP critical or arrows out.
 */
async function fightDragon () {
  if (dragonActive) return 'Already fighting the dragon'

  // ── Pre-flight ──
  const dim = (bot.game?.dimension || '').toLowerCase()
  if (!dim.includes('end')) {
    return `Not in The End (current dimension: ${bot.game?.dimension || 'unknown'})`
  }

  const bow = bestBow()
  if (!bow) return 'No bow in inventory — get a bow first!'
  if (arrowCount() < 1) return 'No arrows in inventory — get arrows first!'

  // Make sure we wait for dragon to actually appear in entity list.
  let dragon = findDragon()
  if (!dragon) {
    safeChat('Searching for the dragon...')
    for (let i = 0; i < 10 && !dragon; i++) {
      await sleep(500)
      dragon = findDragon()
    }
    if (!dragon) return 'Cannot find the Ender Dragon nearby'
  }

  dragonActive = true
  miningActive = false
  stopDefend()

  safeChat(`Engaging the Ender Dragon. Arrows: ${arrowCount()} | Bow: ${bow.name}`)

  let shotsAtDragon = 0
  let crystalsKilled = 0
  const stubbornCrystals = new Set()
  const startTime = Date.now()
  const TIMEOUT_MS = 20 * 60 * 1000  // hard 20-min cap so we never loop forever

  try {
    try { await bot.equip(bow, 'hand') } catch (_) {}

    while (dragonActive) {
      if (Date.now() - startTime > TIMEOUT_MS) {
        safeChat('Dragon fight timed out (20 min) — stopping.')
        break
      }

      // Dragon entity refresh
      dragon = findDragon()
      if (!dragon) {
        safeChat(`DRAGON DEFEATED! Shots fired: ${shotsAtDragon}, crystals: ${crystalsKilled}`)
        break
      }

      // ── Health / hunger management ──
      const hp = bot.health ?? 20
      const food = bot.food ?? 20
      if (hp <= 8) {
        safeChat(`HP ${hp} — retreating to eat.`)
        try { bot.pathfinder.setGoal(null) } catch (_) {}
        try { await eatFood() } catch (_) {}
        await sleep(400)
        try { await bot.equip(bestBow() || bow, 'hand') } catch (_) {}
        continue
      }
      if (food < 16) {
        try { await eatFood() } catch (_) {}
        try { await bot.equip(bestBow() || bow, 'hand') } catch (_) {}
      }

      // ── Bail conditions ──
      if (arrowCount() < 1) {
        safeChat('Out of arrows — fight aborted.')
        break
      }
      if (!bestBow()) {
        safeChat('Bow broke / lost — fight aborted.')
        break
      }

      // ── Avoid the void: stay near the central island. ──
      const distFromOrigin = Math.sqrt(
        bot.entity.position.x ** 2 + bot.entity.position.z ** 2)
      if (distFromOrigin > 80) {
        safeChat('Too far from center — pulling back.')
        try {
          await bot.pathfinder.goto(new goals.GoalNear(0, bot.entity.position.y, 0, 6))
        } catch (_) {}
      }

      const distToDragon = bot.entity.position.distanceTo(dragon.position)
      const perched = isDragonPerched(dragon)
      const crystals = findEndCrystals().filter(c => !stubbornCrystals.has(c.id))

      // ── PRIORITY 1: dragon is PERCHED — best damage window, take the shot now ──
      if (perched && distToDragon < 60) {
        // Dodge: if dragon is very close (charge attack), strafe between shots.
        if (distToDragon < 10) {
          const strafeDir = Math.random() < 0.5 ? 'left' : 'right'
          try { bot.setControlState(strafeDir, true) } catch (_) {}
          await sleep(250)
          try { bot.setControlState(strafeDir, false) } catch (_) {}
        }
        await aimAtEntity(dragon, 0)  // perched = stationary, no lead needed
        await chargeAndFire(1150)
        shotsAtDragon++
        if (shotsAtDragon % 10 === 0) {
          safeChat(`PERCH SHOT! ${shotsAtDragon} fired | HP ${bot.health}/20 | arrows ${arrowCount()}`)
        }
        await sleep(300)
        continue
      }

      // ── PRIORITY 2: dragon is CLOSE & visible — opportunistic shot ──
      // Even with crystals up, if the dragon flies close, take a free shot.
      if (distToDragon < 30) {
        // Strafe to dodge if it's right on top of us.
        if (distToDragon < 12) {
          const strafeDir = Math.random() < 0.5 ? 'left' : 'right'
          try { bot.setControlState(strafeDir, true) } catch (_) {}
          await sleep(300)
          try { bot.setControlState(strafeDir, false) } catch (_) {}
        }
        await aimAtEntity(dragon, 6)  // moving target — use lead
        await chargeAndFire(1100)
        shotsAtDragon++
        if (shotsAtDragon % 10 === 0) {
          safeChat(`${shotsAtDragon} shots fired | HP ${bot.health}/20 | arrows ${arrowCount()}`)
        }
        await sleep(300)
        continue
      }

      // ── PRIORITY 3: kill the nearest reachable End Crystal ──
      if (crystals.length > 0) {
        const target = crystals[0]
        const tp = target.position
        const distToCrystal = bot.entity.position.distanceTo(tp)

        if (distToCrystal > 50) {
          try {
            bot.pathfinder.setMovements(getMovements())
            await bot.pathfinder.goto(
              new goals.GoalNear(tp.x, bot.entity.position.y, tp.z, 18))
          } catch (_) {}
        }

        let crystalDown = false
        for (let attempt = 0; attempt < 3 && !crystalDown && dragonActive; attempt++) {
          if (arrowCount() < 1) break
          const stillThere = bot.entities[target.id]
          if (!stillThere) { crystalDown = true; break }

          // Mid-crystal-volley: if the dragon perched, abort and snipe it.
          const dCheck = findDragon()
          if (dCheck && isDragonPerched(dCheck)) break

          await aimAtEntity(stillThere)
          await chargeAndFire(1100)
          await sleep(900)

          if (!bot.entities[target.id]) {
            crystalDown = true
            crystalsKilled++
            const remaining = findEndCrystals().length
            safeChat(`Crystal down! (${crystalsKilled} killed, ${remaining} left)`)
          } else {
            try {
              const nextX = tp.x + (Math.random() - 0.5) * 8
              const nextZ = tp.z + (Math.random() - 0.5) * 8
              await bot.pathfinder.goto(
                new goals.GoalNear(nextX, bot.entity.position.y, nextZ, 2))
            } catch (_) {}
          }
        }

        if (!crystalDown && bot.entities[target.id]) {
          stubbornCrystals.add(target.id)
          safeChat(`Crystal at (${Math.round(tp.x)},${Math.round(tp.z)}) blocked — moving on.`)
        }
        continue
      }

      // ── PRIORITY 4: dragon is far / flying high — try a long-range shot ──
      // No more crystals to focus on, and dragon isn't close. Take what we can.
      if (distToDragon < 80) {
        await aimAtEntity(dragon, 8)  // big lead — long arrow flight time
        await chargeAndFire(1150)
        shotsAtDragon++
        if (shotsAtDragon % 10 === 0) {
          safeChat(`${shotsAtDragon} shots fired | HP ${bot.health}/20 | arrows ${arrowCount()}`)
        }
        await sleep(350)
        continue
      }

      // ── Dragon way out of range: pull back to center and wait. ──
      try {
        await bot.pathfinder.goto(new goals.GoalNear(0, bot.entity.position.y, 0, 4))
      } catch (_) {}
      await sleep(500)
    }
  } catch (e) {
    console.log('[dragon]', e.message)
    safeChat(`Dragon fight error: ${e.message.slice(0, 80)}`)
  } finally {
    dragonActive = false
    try { bot.deactivateItem() } catch (_) {}
    try { bot.clearControlState('left') } catch (_) {}
    try { bot.clearControlState('right') } catch (_) {}
  }

  return 'Dragon fight ended'
}

/* ═══════════════════════════════════════════
   EATING + ITEMS
═══════════════════════════════════════════ */
const FOOD_PRIORITY = [
  'golden_apple', 'enchanted_golden_apple',
  'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
  'cooked_salmon', 'cooked_cod', 'bread', 'baked_potato',
  'apple', 'carrot', 'potato', 'melon_slice',
  'beef', 'porkchop', 'chicken', 'sweet_berries'
]

async function eatFood () {
  const food = bot.inventory.items()
    .find(i => FOOD_PRIORITY.some(f => i.name.includes(f)))
  if (!food) return 'No food!'

  try {
    await bot.equip(food, 'hand')
    await bot.consume()
    return `Ate ${food.name}`
  } catch (e) {
    return `Eat failed: ${e.message}`
  }
}

async function pickupNearbyItems () {
  const drops = Object.values(bot.entities)
    .filter(e => e.name === 'item' || e.objectType === 'Item')
    .slice(0, 10)
  if (!drops.length) return 'No drops nearby'
  for (const drop of drops) {
    try { await gotoNear(drop.position.x, drop.position.y, drop.position.z, 1) } catch (_) {}
  }
  return `Collected ${drops.length} item(s)`
}

function readDroppedItemName (entity) {
  const nbtName =
    entity?.metadata?.[8]?.nbtData?.value?.Item?.value?.id?.value ||
    entity?.metadata?.[8]?.itemId

  if (typeof nbtName === 'string' && nbtName) return nbtName.replace('minecraft:', '')
  if (typeof nbtName === 'number' && mcData?.items?.[nbtName]?.name) return mcData.items[nbtName].name

  return entity?.displayName || entity?.name || 'item'
}

function findDroppedItems (itemName = '') {
  const drops = Object.values(bot.entities)
    .filter(e => e?.position && (e.name === 'item' || e.objectType === 'Item'))

  if (!drops.length) return []

  const normalized = itemName.toLowerCase().trim().replace(/\s+/g, '_')
  if (!normalized) return drops

  return drops.filter(e => readDroppedItemName(e).toLowerCase().includes(normalized))
}

function findDroppedItemsMessage (itemName = '') {
  const matches = findDroppedItems(itemName)
  if (!matches.length) {
    return itemName
      ? `No dropped ${itemName} nearby`
      : 'No dropped items nearby'
  }

  const nearest = matches
    .slice()
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]

  const p = nearest.position
  const d = Math.round(p.distanceTo(bot.entity.position))
  const label = readDroppedItemName(nearest)

  if (!itemName) {
    const sample = matches
      .slice(0, 3)
      .map(e => readDroppedItemName(e))
      .join(', ')
    return `Nearest dropped item: ${label} at ${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)} (${d}m). Nearby: ${sample}`
  }

  return `Nearest dropped ${itemName}: ${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)} (${d}m)`
}

async function equipByName (itemName, slot = 'hand') {
  const item = findItem(i => itemHas(i, itemName))
  if (!item) return `No ${itemName} in inventory`
  try { await bot.equip(item, slot); return `Equipped ${item.name}` }
  catch (e) { return `Equip failed: ${e.message}` }
}

async function dropItem (itemName, count = 1) {
  const item = findItem(i => itemHas(i, itemName))
  if (!item) return `No ${itemName} to drop`
  try {
    await bot.toss(item.type, null, Math.min(count, item.count))
    return `Dropped ${itemName}`
  } catch (e) {
    return `Drop failed: ${e.message}`
  }
}

async function dropAllInventory () {
  const items = bot.inventory.items()
  if (!items.length) return 'Inventory already empty'

  let droppedStacks = 0
  for (const item of items) {
    try {
      await bot.tossStack(item)
      droppedStacks++
      await sleep(50)
    } catch (_) {}
  }

  return droppedStacks ? `Dropped ${droppedStacks} stack(s)` : 'Could not drop inventory'
}

/* ═══════════════════════════════════════════
   SURVIVAL LOOP (with anti-drown integrated)
═══════════════════════════════════════════ */
async function survivalTick () {
  if (!bot?.entity) return

  const hp   = bot.health ?? 20
  const food = bot.food ?? 20
  const air  = bot.oxygenLevel ?? 300  // 0-300 air bubbles

  // ── If we're mid-dig OR fighting the dragon, don't run anything that could
  // equip / move / interrupt. The dragon fight manages its own eating + dodging.
  const digging = !!bot.targetDigBlock || miningActive
  const busy = digging || dragonActive

  // ── ANTI-DROWN: still fires (no water in The End anyway). ──
  if (!drowningEscape && (isSubmerged() || air < CONFIG.drowningAirThreshold)) {
    console.log(`[anti-drown] Triggered — air: ${air}, submerged: ${isSubmerged()}`)
    escapeWater().catch(e => console.log('[anti-drown]', e.message))
    return
  }

  // ── Auto eat: skip during mining/dragon unless food is critically low. ──
  // Equipping food while bot.dig() / bot.activateItem(bow) is active cancels it.
  const foodCritical = food <= 6
  if (food < CONFIG.autoEatThreshold && (!busy || foodCritical)) {
    try { await eatFood() } catch (_) {}
  }

  // ── Low health emergency (skip during dragon fight: it has its own logic). ──
  if (hp <= CONFIG.fleeHealthThreshold && !dragonActive) {
    safeChat('Low HP! Retreating...')
    bot.setControlState('jump', true)
    bot.setControlState('back', true)
    await sleep(1200)
    stopMovement()
    try { await eatFood() } catch (_) {}
    return
  }

  // ── Auto defend self (skip while mining or dragon-fighting) ──
  if (!busy) {
    const nearHostile = findEntity(e =>
      isHostileEntity(e) &&
      e.position.distanceTo(bot.entity.position) < CONFIG.hostileAlertRange
    , CONFIG.hostileAlertRange)

    if (nearHostile && !defendInterval && !speedrunActive) {
      await equipBestGear()
      try { bot.attack(nearHostile) } catch (_) {}
    }
  }

  // ── Auto equip armor on first loop (armor slots don't disturb held tool). ──
  if (!survivalTimer._armorEquipped) {
    survivalTimer._armorEquipped = true
    try {
      const slots = ['head', 'torso', 'legs', 'feet']
      const armor = { head: 'helmet', torso: 'chestplate', legs: 'leggings', feet: 'boots' }
      const tiers = ['netherite', 'diamond', 'iron', 'chainmail', 'gold', 'leather']
      for (const slot of slots) {
        for (const tier of tiers) {
          const piece = findItem(i => i.name === `${tier}_${armor[slot]}`)
          if (piece) {
            try { await bot.equip(piece, slot); break } catch (_) {}
          }
        }
      }
    } catch (_) {}
  }
}

function startSurvivalLoop () {
  if (survivalTimer) clearInterval(survivalTimer)
  survivalTimer = setInterval(() => {
    survivalTick().catch(e => console.log('[survival]', e.message))
  }, CONFIG.survivalIntervalMs)
}

/* ═══════════════════════════════════════════
   ROBOT MODE
═══════════════════════════════════════════ */
function startRobotMode () {
  stopAllTasks()
  robotTimer = setInterval(async () => {
    if (!bot?.entity) return
    if (isInWater()) return  // Don't robot-act while in water
    const roll = Math.floor(Math.random() * 6)
    if (roll === 0) await bot.look((bot.entity.yaw || 0) + Math.PI / 2, Math.random() * 0.4 - 0.2, true).catch(() => {})
    else if (roll === 1) { bot.setControlState('sneak', true); setTimeout(() => bot.setControlState('sneak', false), 700) }
    else if (roll === 2) { bot.setControlState('jump', true); setTimeout(() => bot.setControlState('jump', false), 350) }
    else if (roll === 3) { try { await pickupNearbyItems() } catch (_) {} }
    else if (roll === 4) { try { await wander() } catch (_) {} }
    else console.log('[robot] Status:', statusReport())
  }, 3800)
  return 'Robot mode ON'
}

/* ═══════════════════════════════════════════
   SPEEDRUN
═══════════════════════════════════════════ */
async function speedrun () {
  if (speedrunActive) return 'Already speedrunning'
  speedrunActive = true
  startSurvivalLoop()

  const LOGS = ['oak_log','birch_log','spruce_log','jungle_log','dark_oak_log','acacia_log','mangrove_log','cherry_log']

  const stages = [
    { name: 'Get wood (x8)',     fn: () => mineBlocks(LOGS, 8) },
    { name: 'Craft planks',      fn: () => craftItem('oak_planks', 4) },
    { name: 'Craft sticks',      fn: () => craftItem('stick', 4) },
    { name: 'Craft table',       fn: () => craftItem('crafting_table', 1) },
    {
      name: 'Place table',
      fn: async () => {
        const t = findItem(i => i.name === 'crafting_table')
        if (!t) return 'No table'
        await bot.equip(t, 'hand')
        const ref = bot.blockAt(bot.entity.position.offset(1, -1, 0))
        if (!ref) return 'No floor'
        await bot.placeBlock(ref, { x: 0, y: 1, z: 0 })
        return 'Placed table'
      }
    },
    { name: 'Craft w.pickaxe',   fn: () => craftItem('wooden_pickaxe', 1) },
    { name: 'Craft w.sword',     fn: () => craftItem('wooden_sword', 1) },
    { name: 'Mine stone (x12)',  fn: () => mineBlocks(['stone','cobblestone'], 12) },
    { name: 'Craft s.pickaxe',   fn: () => craftItem('stone_pickaxe', 1) },
    { name: 'Craft s.sword',     fn: () => craftItem('stone_sword', 1) },
    { name: 'Craft furnace',     fn: () => craftItem('furnace', 1) },
    { name: 'Mine iron (x6)',    fn: () => mineBlocks(['iron_ore','deepslate_iron_ore'], 6) },
    { name: 'Mine coal (x4)',    fn: () => mineBlocks(['coal_ore','deepslate_coal_ore'], 4) },
    { name: 'Smelt iron',        fn: () => smeltItems('iron_ore', 'coal', 6) },
    { name: 'Craft i.pickaxe',   fn: () => craftItem('iron_pickaxe', 1) },
    { name: 'Craft i.sword',     fn: () => craftItem('iron_sword', 1) },
    { name: 'Mine diamonds',     fn: () => mineBlocks(['diamond_ore','deepslate_diamond_ore'], 3) },
  ]

  safeChat('Speedrun started!')

  for (const stage of stages) {
    if (!speedrunActive) break
    safeChat(`> ${stage.name}`)
    try {
      const r = await stage.fn()
      console.log(`[speedrun] ${stage.name}:`, r)
    } catch (e) {
      console.log(`[speedrun] ${stage.name} failed:`, e.message)
    }
    await sleep(400)
  }

  speedrunActive = false
  safeChat('Speedrun done! Early game complete.')
  return 'Speedrun finished'
}

/* ═══════════════════════════════════════════
   ACTION EXECUTOR
═══════════════════════════════════════════ */
async function executeAction (action, args = {}) {
  if (!action) return null
  switch (action) {
    case 'follow_owner':   return followOwner()
    case 'stop':           stopAllTasks(); return null
    case 'mine':           return `Mined ${await mineBlocks(args.blocks || ['oak_log'], args.count || 4)}`
    case 'craft':          return craftItem(args.item || 'crafting_table', args.count || 1)
    case 'goto_player':    return gotoPlayer(args.name || CONFIG.owner)
    case 'goto_coords':    return gotoCoords(args.x, args.y, args.z)
    case 'attack':         return attackNearest()
    case 'eat':            return eatFood()
    case 'pickup':         return pickupNearbyItems()
    case 'find_dropped':   return findDroppedItemsMessage(args.item || '')
    case 'build_tower':    return buildTower(args.height || 5, args.block || 'dirt')
    case 'build_house':    return buildHouse(args.size || 5)
    case 'smelt':          return smeltItems(args.item || 'iron_ore', args.fuel || 'coal', args.count || 4)
    case 'sleep':          return sleepInBed()
    case 'equip':          return equipByName(args.item || '', args.slot || 'hand')
    case 'drop':           return dropItem(args.item || '', args.count || 1)
    case 'drop_all':       return dropAllInventory()
    case 'place':          return placeBlockNearby(args.item || 'dirt')
    case 'find_diamond':   return findNearestDiamond()
    case 'find_resource':  return findNearestResourceMessage(args.name || 'diamond')
    case 'mine_resource':  return mineResourceByName(args.name || 'diamond', args.count || 1)
    case 'run_command':    return runServerCommand(args.command || '')
    case 'wander':         return wander()
    case 'dance':          return dance()
    case 'robot_mode':     return startRobotMode()
    case 'speedrun':       speedrun().catch(e => console.log('[speedrun]', e.message)); return null
    case 'defend':         return startDefend()
    case 'stop_defend':    stopDefend(); return null
    case 'scan':           return scanAround()
    case 'status':         return statusReport()
    case 'inventory':      return inventoryReport()
    case 'where_am_i':     return whereAmI()
    case 'find_player':    return whereIsPlayer(args.name || CONFIG.owner)
    case 'find_end_city':  return locateEndCity()
    case 'back_to_death':  return backToDeath()
    case 'farm':           return farmCrops(args.crop || 'wheat', args.count || 8)
    case 'fight_dragon':
    case 'kill_dragon':
    case 'solo_dragon':
      fightDragon()
        .then(result => result && safeChat(result))
        .catch(e => safeChat(`Dragon error: ${e.message.slice(0, 80)}`))
      return 'Engaging the Ender Dragon...'
    default:               return null
  }
}

/* ═══════════════════════════════════════════
   MAIN MESSAGE HANDLER
═══════════════════════════════════════════ */
async function handleMessage (rawMessage) {
  const text = rawMessage.trim()
  const firstToken = text.split(/\s+/)[0].toLowerCase()

  // ── Admin toggles ──
  if (firstToken === '.ai_on')    { aiEnabled = true;  return 'AI enabled ✓' }
  if (firstToken === '.ai_off')   { aiEnabled = false; return 'AI disabled' }
  if (firstToken === '.clear')    { conversationHistory = []; return 'Memory cleared' }
  if (firstToken === '.status')   return statusReport()
  if (firstToken === '.inv')      return inventoryReport()
  if (firstToken === '.where')    return whereAmI()
  if (firstToken === '.death')    return backToDeath()
  if (firstToken === '.diamond')  return findNearestDiamond()
  if (firstToken === '.diamonds') return findNearestResourceMessage('diamonds')
  if (firstToken === '.iron')     return findNearestResourceMessage('iron')
  if (firstToken === '.gold')     return findNearestResourceMessage('gold')
  if (firstToken === '.coal')     return findNearestResourceMessage('coal')
  if (firstToken === '.emerald')  return findNearestResourceMessage('emerald')
  if (firstToken === '.redstone') return findNearestResourceMessage('redstone')
  if (firstToken === '.lapis')    return findNearestResourceMessage('lapis')
  if (firstToken === '.copper')   return findNearestResourceMessage('copper')
  if (firstToken === '.city')     return locateEndCity()
  if (firstToken === '.drops') {
    const query = text.split(/\s+/).slice(1).join('_').trim()
    return findDroppedItemsMessage(query)
  }
  if (firstToken === '.stop')     { stopAllTasks(); return 'Stopped' }
  if (firstToken === '.dragon' || firstToken === '.enderdragon' || firstToken === '.endfight') {
    fightDragon()
      .then(result => result && safeChat(result))
      .catch(e => safeChat(`Dragon error: ${e.message.slice(0, 80)}`))
    return 'Engaging the Ender Dragon...'
  }
  if (text.startsWith('.cmd ')) return runServerCommand(text.slice(5).trim())
  if (text.startsWith('/')) return runServerCommand(text)

  // ── ! prefix: mine a resource OR fight dragon ──
  if (text.startsWith('!')) {
    const parts = text.slice(1).trim().split(/\s+/)
    const target = parts[0].toLowerCase().replace(/\s+/g, '_')
    const count  = parseInt(parts[1]) || 1
    if (!target) return 'Use !<resource> [count], e.g. !diamond or !iron 3'

    if (target === 'dragon' || target === 'enderdragon' || target === 'ender_dragon') {
      fightDragon()
        .then(result => result && safeChat(result))
        .catch(e => safeChat(`Dragon error: ${e.message.slice(0, 80)}`))
      return 'Engaging the Ender Dragon...'
    }

    mineResourceByName(target, count)
      .then(result => safeChat(result))
      .catch(e => safeChat(`Mining error: ${e.message.slice(0, 80)}`))
    return `Starting to mine ${count}x ${target}...`
  }

  // Grounded intents
  const grounded = detectGroundedIntent(text)
  if (grounded) {
    const groundedReply = await executeAction(grounded.action, grounded.args || {})
    if (groundedReply) {
      conversationHistory.push({ role: CONFIG.username, content: groundedReply })
      return groundedReply
    }
  }

  conversationHistory.push({ role: CONFIG.owner, content: text })
  if (conversationHistory.length > CONFIG.maxConvHistory) conversationHistory.shift()

  // ── AI-primary path ──
  if (aiEnabled) {
    if (aiBusy) {
      safeChat('Still thinking... wait a sec')
      return null
    }

    if (isLikelyQuestion(text)) {
      aiBusy = true
      try {
        const quick = await askPollinationsPlain(text)
        if (quick) {
          conversationHistory.push({ role: CONFIG.username, content: quick })
          return quick
        }
      } finally {
        aiBusy = false
      }
      return localFallback(text)
    }

    aiBusy = true
    let aiResult = null

    try {
      aiResult = await askPollinationsJSON(text)
    } finally {
      aiBusy = false
    }

    if (aiResult) {
      let actionFeedback = null
      if (aiResult.action) {
        try {
          actionFeedback = await executeAction(aiResult.action, aiResult.args || {})
        } catch (e) {
          console.log('[action]', e.message)
          actionFeedback = `Oops: ${e.message.slice(0, 60)}`
        }
      }

      const reply = aiResult.reply || actionFeedback || ''

      if (reply) {
        conversationHistory.push({ role: CONFIG.username, content: reply })
        lastThought = reply
        return reply
      }
      if (actionFeedback) return actionFeedback
      return null
    }

    aiBusy = true
    let plainReply = null
    try {
      plainReply = await askPollinationsPlain(text)
    } finally {
      aiBusy = false
    }
    if (plainReply) {
      conversationHistory.push({ role: CONFIG.username, content: plainReply })
      return plainReply
    }
  }

  return localFallback(text)
}

/* ═══════════════════════════════════════════
   BOT LIFECYCLE
═══════════════════════════════════════════ */
let shuttingDown = false
let connectWatchdogTimer = null
let reconnectReason = 'startup'
let reconnectGeneration = 0

function clearRuntimeLoops () {
  if (survivalTimer)  { clearInterval(survivalTimer);  survivalTimer = null }
  if (robotTimer)     { clearInterval(robotTimer);     robotTimer = null }
  if (autoEatTimer)   { clearInterval(autoEatTimer);   autoEatTimer = null }
  stopDefend()
}

function clearReconnectTimers () {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  if (connectWatchdogTimer) { clearTimeout(connectWatchdogTimer); connectWatchdogTimer = null }
}

function scheduleReconnect (reason = 'disconnect', immediate = false) {
  if (shuttingDown) return
  reconnectReason = reason || reconnectReason
  if (reconnectTimer) return

  reconnectCount++
  // Aternos frequently drops handshake packets; retry faster, especially early attempts.
  const baseDelay = immediate ? 0 : (Math.min(15000, 2000 * reconnectCount) + Math.random() * 1000)
  const resetBackoff = Math.min(45000, econnresetStreak * 3000)
  const delay = baseDelay + reconnectPenaltyMs + resetBackoff
  reconnectPenaltyMs = Math.max(0, reconnectPenaltyMs - 2000)

  console.log(`[bot] Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${reconnectCount}, reason: ${reconnectReason})`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    createBot()
  }, delay)
}

function tryInstantRespawn () {
  if (!bot || shuttingDown) return
  // Keep retrying for a few seconds; some servers delay the death screen packet.
  let tries = 0
  const maxTries = 15
  const timer = setInterval(() => {
    tries++
    if (!bot || shuttingDown || tries > maxTries) {
      clearInterval(timer)
      return
    }
    try {
      if (typeof bot.respawn === 'function') bot.respawn()
      else if (bot._client && typeof bot._client.write === 'function') {
        // Protocol fallback for older versions.
        bot._client.write('client_command', { actionId: 0 })
      }
    } catch (_) {}
  }, 200)
}

function createBot () {
  if (shuttingDown) return
  clearReconnectTimers()
  clearRuntimeLoops()
  reconnectGeneration += 1
  const myGeneration = reconnectGeneration

  // Ensure old instance is closed before replacing.
  if (bot) {
    try { bot.end('reconnecting') } catch (_) {}
  }

  console.log(`[bot] Connecting → ${CONFIG.host}:${CONFIG.port} as ${CONFIG.username} (${activeAuthMode})`)
  const thisBot = mineflayer.createBot({
    host:     CONFIG.host,
    port:     CONFIG.port,
    username: CONFIG.username,
    auth:     activeAuthMode,
  })
  bot = thisBot
  thisBot.loadPlugin(pathfinder)
  mcData = null

  // If we don't spawn quickly, force a reconnect.
  connectWatchdogTimer = setTimeout(() => {
    if (shuttingDown || myGeneration !== reconnectGeneration) return
    console.log('[bot] Connect watchdog timeout — forcing reconnect')
    try { thisBot.end('connect_watchdog_timeout') } catch (_) {}
    scheduleReconnect('connect_watchdog_timeout', true)
  }, 35000)

  /* ── spawn ── */
  thisBot.once('spawn', () => {
    if (myGeneration !== reconnectGeneration || thisBot !== bot) return
    if (connectWatchdogTimer) { clearTimeout(connectWatchdogTimer); connectWatchdogTimer = null }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
    reconnectCount = 0
    reconnectPenaltyMs = 0
    econnresetStreak = 0
    drowningEscape = false
    miningActive = false
    dragonActive = false
    mcData = require('minecraft-data')(thisBot.version)
    console.log('[bot] Spawned as', thisBot.username, '— version', thisBot.version)
    startSurvivalLoop()
  })

  /* ── death ── */
  thisBot.on('death', () => {
    if (myGeneration !== reconnectGeneration || thisBot !== bot) return
    if (thisBot.entity) {
      deathLocation = thisBot.entity.position.clone()
      console.log('[bot] Died at', Math.round(deathLocation.x), Math.round(deathLocation.y), Math.round(deathLocation.z))
    }
    stopAllTasks()
    drowningEscape = false
    miningActive = false
    dragonActive = false
    tryInstantRespawn()
  })

  /* ── health low warning ── */
  thisBot.on('health', () => {
    if (myGeneration !== reconnectGeneration || thisBot !== bot) return
    if ((thisBot.health ?? 20) <= 4) {
      console.log('[survival] Critical HP:', thisBot.health)
    }
  })

  /* ── real-time drowning hook via physicsTickEnded ── */
  thisBot.on('physicsTick', () => {
    if (myGeneration !== reconnectGeneration || thisBot !== bot) return
    if (!drowningEscape && thisBot?.entity && isSubmerged()) {
      const air = thisBot.oxygenLevel ?? 300
      if (air < 150) {
        thisBot.setControlState('jump', true)
        setTimeout(() => {
          if (bot === thisBot) thisBot.setControlState('jump', false)
        }, 200)
      }
    }
  })

  /* ── chat ── */
  thisBot.on('chat', async (chatUsername, message) => {
    if (myGeneration !== reconnectGeneration || thisBot !== bot) return
    if (chatUsername === thisBot.username) return
    if (chatUsername !== CONFIG.owner) return

    let reply = null
    try {
      reply = await handleMessage(message)
    } catch (e) {
      console.log('[handler] error:', e.message)
      reply = `Error: ${e.message.slice(0, 80)}`
    }

    if (reply) safeChat(reply)
  })

  /* ── whisper support ── */
  thisBot.on('whisper', async (chatUsername, message) => {
    if (myGeneration !== reconnectGeneration || thisBot !== bot) return
    if (chatUsername !== CONFIG.owner) return
    let reply = null
    try { reply = await handleMessage(message) } catch (_) {}
    if (reply) thisBot.whisper(chatUsername, reply).catch(() => {})
  })

  /* ── error / disconnect ── */
  thisBot.on('error', err => {
    if (myGeneration !== reconnectGeneration || thisBot !== bot) return
    const code = err?.code || err?.message
    if (code === 'ECONNRESET') {
      econnresetStreak += 1
      reconnectPenaltyMs = Math.min(30000, reconnectPenaltyMs + 1500)

      // Switch auth mode earlier to recover quicker from server-side auth mismatch.
      if (CONFIG.auth === 'auto' && econnresetStreak >= 2) {
        activeAuthMode = (activeAuthMode === 'offline') ? 'microsoft' : 'offline'
        econnresetStreak = 0
        reconnectPenaltyMs = Math.min(30000, reconnectPenaltyMs + 2500)
        console.log(`[bot] Auto-switching auth mode to: ${activeAuthMode}`)
      }
    }
    console.log('[bot] Error:', code)
    // Some error paths don't emit "end" promptly; schedule fallback reconnect.
    scheduleReconnect(`error:${String(code).slice(0, 40)}`)
  })

  thisBot.on('kicked', reason => {
    if (myGeneration !== reconnectGeneration || thisBot !== bot) return
    reconnectPenaltyMs = Math.min(45000, reconnectPenaltyMs + 6000)
    console.log('[bot] Kicked:', reason)
    scheduleReconnect('kicked')
  })

  thisBot.on('end', reason => {
    if (myGeneration !== reconnectGeneration || thisBot !== bot) return
    console.log('[bot] Disconnected:', reason || 'socketClosed')
    clearRuntimeLoops()
    drowningEscape = false
    miningActive = false
    dragonActive = false
    scheduleReconnect(reason || 'end')
  })
}

/* ═══════════════════════════════════════════
   ENTRYPOINT + GRACEFUL SHUTDOWN
═══════════════════════════════════════════ */
createBot()

process.on('SIGINT',  gracefulShutdown)
process.on('SIGTERM', gracefulShutdown)

function gracefulShutdown () {
  console.log('[bot] Shutting down...')
  shuttingDown = true
  clearReconnectTimers()
  clearRuntimeLoops()
  if (bot) bot.end()
  process.exit(0)
}

const http = require('http')
http.createServer((req, res) => res.end('Bot is running!')).listen(process.env.PORT || 3000)