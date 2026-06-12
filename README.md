# BTC Bot

Bot de trading algorítmico para BTCUSDT Perpetual en Bybit, basado en EMA Pullback. Analiza el mercado en tiempo real, detecta setups de alta probabilidad y ejecuta órdenes directamente via API REST de Bybit — sin MT5, sin bridge Python.

## Arquitectura

```
┌─────────────────────────────────────────────────────────┐
│                    Bybit REST API                        │
│  /v5/market/kline  /v5/account  /v5/position  /v5/order │
└──────────────────────┬──────────────────────────────────┘
                       │ HTTP (bybit-api SDK)
┌──────────────────────▼──────────────────────────────────┐
│                  bot-core  (TypeScript)                  │
│                                                          │
│  MarketDataService  (D1 / H4 / H1 / M15 / M5)          │
│    ├─ EMAEngine        (EMA 8/34 en H4, H1 y M15)      │
│    ├─ MACDEngine       (histograma MACD en M15)         │
│    ├─ ADXEngine        (ADX en H4 para filtro de trend) │
│    ├─ FVGDetector      (Fair Value Gaps en M5)          │
│    ├─ DisplacementDetector  (velas impulso en M5)       │
│    ├─ EntryValidator   (momentum + FVG + displacement)  │
│    ├─ PositionSizing   (qty = riskUSD / slDistanceUSD)  │
│    └─ PositionMonitor  (trailing stop configurable)     │
│                                                          │
│  Filtros de riesgo (se evalúan antes de cada orden)     │
│    ├─ NewsFilterService      (bloqueo ±1 min noticias)  │
│    ├─ SessionGuard           (horarios bloqueados ET)   │
│    ├─ DailyTradeCountGuard   (máximo trades por día)    │
│    ├─ DailyLossGuard         (máximo pérdidas por día)  │
│    └─ ConsecLossGuard        (circuit breaker diario)   │
│                                                          │
│  TradeJournalService  (registro de operaciones en DB)   │
│  BotStatusService     (semáforo en tiempo real)         │
│  Dashboard Express    (http://localhost:8002)            │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│              Telegram Bot  (notificaciones)              │
└─────────────────────────────────────────────────────────┘
```

## Estrategia: EMA Pullback [EP]

Opera una única estrategia sobre BTCUSDT Perpetual en Bybit con apalancamiento 5x (configurable).

### Lógica de entrada

1. **Alineación top-down H4 → H1** — `EP_H4_ALIGN=true`: EMA8 H4 debe estar al mismo lado de EMA34 que la dirección H1.

2. **Tendencia H1 confirmada** — EMA8 > EMA34 en H1 → BULLISH; EMA8 < EMA34 → BEARISH. La separación debe ser ≥ `EMA_SPREAD_MIN` para evitar mercados choppy.

3. **Precio cerca de EMA34 en M15** — el precio debe estar dentro de `ZONE_PROXIMITY_POINTS` USD de la EMA34 en M15.

4. **MACD confirma momentum** — el histograma MACD en M15 debe estar en la dirección del trade.

5. **Entrada y niveles** — el SL va más allá de la EMA34 en M15 (`ZONE_SL_BUFFER_POINTS` USD). El TP garantiza mínimo 2:1 R:R.

## Gestión de posiciones

- **Trailing stop** — cuando `TRAIL_RR > 0`: el SL sigue al precio manteniéndose a `TRAIL_RR × slDist` detrás del precio pico. Con `TRAIL_RR=1.5`, activa a 1.5R de ganancia.
- **Break-even** — cuando `BE_AT_POINTS > 0` y el precio se mueve ese valor en USD a favor, el SL se mueve al precio de entrada + `BE_BUFFER_POINTS`.
- **Partial TP** — cuando `PARTIAL_TP_ENABLED=true`, al alcanzar el trigger cierra el 50% y mueve SL a break-even.

## Position sizing

BTC perpetuos USDT-marginados: no se necesita tick value.

```
qty (BTC) = riskUSD / slDistanceUSD
riskUSD   = balance × RISK_PERCENT / 100
```

**Ejemplo** (balance $1,000, `RISK_PERCENT=1`, SL a $500):
```
riskUSD = $10
qty     = 10 / 500 = 0.02 BTC
```

Mínimo: 0.001 BTC. Máximo: `MAX_QTY` (configurable).

## Filtros de riesgo

| Filtro | Comportamiento |
|---|---|
| **News filter** | Bloquea señales ±1 minuto alrededor de noticias USD de alto impacto (Forex Factory). |
| **Session guard** | Bloquea señales fuera de las ventanas horarias (por defecto: 08:00–17:00 ET). |
| **Daily loss limit** | Si el número de pérdidas del día alcanza `MAX_DAILY_LOSSES`, pausa hasta el día siguiente. |
| **Daily trade limit** | Si el número de trades del día alcanza `MAX_DAILY_TRADES`, pausa hasta el día siguiente. `0` = sin límite. |
| **Consecutive loss circuit** | Si se cierran `MAX_CONSEC_LOSSES` pérdidas seguidas, bloquea el resto del día. `0` = desactivado. |
| **Signal cooldown** | Mínimo `SIGNAL_COOLDOWN_MINUTES` (90 min) entre señales. |

### Ventana de operación por defecto (hora ET)

| Franja | Horario | Descripción |
|---|---|---|
| 🔴 Bloqueado | 00:00 – 08:00 | Sesión asiática + madrugada |
| 🟢 **Activo** | 08:00 – 17:00 | Sesión US — mayor volumen institucional |
| 🔴 Bloqueado | 17:00 – 00:00 | Post-mercado |

## Stack tecnológico

| Capa | Tecnología |
|---|---|
| Bot principal | TypeScript, Node.js, tsx |
| Broker | Bybit — BTCUSDT Perpetual (USDT-margined) |
| API | bybit-api SDK (REST + firma HMAC) |
| Notificaciones | Telegram Bot API |
| Licencias / Journal | Neon PostgreSQL |
| Dashboard | Express.js (embebido en el bot) |
| Validación | Zod |
| Logger | Pino |

## Requisitos

- Windows 10/11 o Windows Server
- Node.js 20+
- Cuenta en Bybit con API Key (permisos: Read + Trade)
- Bot de Telegram (opcional) via [@BotFather](https://t.me/BotFather)

> **Restricción geográfica de Bybit:** Bybit bloquea el acceso a su API (CloudFront 403) desde ciertos países, incluyendo EE.UU. Si el bot falla al iniciar con `Cannot connect to Bybit — Bybit bloqueado por geolocalizacion (CloudFront 403)...`, se necesita una VPN/IP de una región donde Bybit esté disponible.

## Instalación

```bash
git clone https://github.com/dnyvelasquez/btcusd-bot.git
cd btcusd-bot
npm install
```

Copia `.env.example` a `.env` y completa:

```env
BYBIT_API_KEY=tu_api_key
BYBIT_API_SECRET=tu_api_secret
BYBIT_TESTNET=false          # true para testnet

TELEGRAM_BOT_TOKEN=          # opcional
TELEGRAM_CHAT_ID=            # opcional

LICENSE_KEY=tu-uuid-de-licencia
DATABASE_URL=postgresql://...
```

## Inicio en desarrollo

```bash
npm run dev
```

Dashboard disponible en `http://localhost:8002`.

## Producción (Windows Scheduled Task)

```powershell
# Una sola vez (como Administrador):
.\install.ps1

# Iniciar / detener:
.\start.ps1
.\stop.ps1
```

## Scripts disponibles

```bash
npm run dev          # Modo desarrollo con hot-reload
npm run build        # Compilar para producción
npm start            # Ejecutar build de producción
npm run backtest     # Modo backtest (ver sección Backtest)
npm run typecheck    # Verificar tipos TypeScript
```

## Backtest

Descarga velas históricas directamente de Bybit API — **no requiere MT5 ni bridge corriendo**.

```bash
npm run backtest -- --start 2024-01-01 --end 2024-12-31
```

### Parámetros disponibles

| Parámetro | Default | Descripción |
|---|---|---|
| `--start` / `--end` | (requeridos) | Rango de fechas `YYYY-MM-DD` |
| `--balance` | `10000` | Balance inicial simulado en USD |
| `--risk` | Desde config | % de riesgo por trade |
| `--leverage` | Desde config | Apalancamiento |
| `--max-qty` | Desde config | Qty máxima en BTC |
| `--cooldown` | Desde config | Minutos de cooldown entre señales |
| `--proximity` | Desde config | Proximidad al EMA34 M15 en USD |
| `--sl-buffer` | Desde config | Buffer SL en USD |
| `--trail-rr` | Desde config | Trailing stop en múltiplos de slDist |
| `--ep-h4-align` | Desde config | Alineación H4 |
| `--tp-rr` | `2` | Multiplicador de TP (2 = 2:1 R:R) |
| `--max-daily-l` | Desde config | Máximo pérdidas por día |

Todos los parámetros de `config.json` se leen automáticamente y se pueden sobrescribir con flags CLI.

### Resultado de referencia (backtest, config actual)

| Período | Trades | WR | PF | P&L | Max DD | Max racha |
|---|---|---|---|---|---|---|
| 2024 (año completo) | 64 | 42.2% | 1.58 | +$2,074 | 6.79% | 7 |
| 2025 (año completo) | 70 | 47.1% | 1.74 | +$3,257 | 6.84% | 5 |
| 2026 (ene – jun) | 23 | 34.8% | 1.05 | +$77 | 6.79% | 7 |

Balance inicial simulado: $10,000 — riesgo 1% por trade — apalancamiento 5x.

## Trade Journal

Cada operación ejecutada en modo live se registra en la tabla `trades` de Neon PostgreSQL:

| Campo | Descripción |
|---|---|
| `ticket` | ID de la orden en Bybit |
| `bybit_account` | UID de la cuenta Bybit |
| `symbol` | Activo operado |
| `side` / `qty` | Dirección y tamaño en BTC |
| `entry_price`, `stop_loss`, `take_profit` | Niveles de la operación |
| `planned_rr` | R:R calculado al abrir |
| `risk_amount` | Capital arriesgado en USD |
| `opened_at` / `closed_at` | Timestamps |
| `profit` | P&L en USD |
| `actual_rr` | R:R realizado |
| `result` | `WIN`, `LOSS` o `BE` |

Al cerrar cada operación también se inserta en `trade_results` para visualización en **[bot-reports](https://bot-reports.vercel.app)**:

| Campo | Valor |
|---|---|
| `owner_name` | Titular (desde `license-cache.json`) |
| `account_type` | `DEMO` o `REAL` |
| `mt5_account` | UID de Bybit (106937526) |
| `bot_name` | `BTC Bot` |
| `symbol` | `BTCUSDT` |
| `profit_usd` | P&L en USD |
| `direction` | `LONG` o `SHORT` |
| `closed_at_et` | Fecha y hora de cierre hora ET |

## Dashboard web

Dashboard embebido en el bot en `http://localhost:8002`:

- **Estado Bybit API** — conexión en tiempo real (verde / rojo)
- **Estado del bot** — semáforo con razón de bloqueo
- **Licencia** — activación y cambio de clave desde el panel; valida contra Neon (clave, estado, vencimiento, modo permitido y UID de Bybit conectado) antes de guardar
- **Configuración** — solo parámetros operativos editables (riesgo por operación, modo live); la estrategia validada en backtests no es editable desde el panel y se ajusta en `config.json`. Hot-reload sin reiniciar
- **Conexión Bybit** — API Key/Secret y entorno (testnet/real) editables, con prueba de conexión antes de guardar; cambios aplican al reiniciar el bot
- **Telegram** — configurar token, chat ID, prueba de envío
- **Journal** — estadísticas (win rate, profit factor, avg R:R, P&L) + tabla de últimas 20 operaciones
