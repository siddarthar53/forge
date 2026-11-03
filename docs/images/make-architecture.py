# Generates architecture.svg (next to this file). Run: python3 docs/images/make-architecture.py
T = {
    1: ("#e8f1fb", "#3b7dd8", "#0b2545"),
    2: ("#e9f7ef", "#2e9e5b", "#0b3d1f"),
    3: ("#fdf1e3", "#d9822b", "#4a2600"),
    0: ("#f4f4f5", "#9a9aa0", "#2b2b30"),
}
out = []
def box(x, y, w, h, tier, name, lines=(), mono=None, strong=False, cyl=False):
    fill, stroke, ink = T[tier]
    sw = 2 if strong else 1.25
    if cyl:
        out.append(f'<path d="M{x} {y+8} a{w/2} 8 0 0 1 {w} 0 v{h-16} a{w/2} 8 0 0 1 {-w} 0 z" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>')
        out.append(f'<path d="M{x} {y+8} a{w/2} 8 0 0 0 {w} 0" fill="none" stroke="{stroke}" stroke-width="{sw}"/>')
    else:
        out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>')
    cx = x + w / 2
    top = y + (30 if cyl else 24)
    out.append(f'<text x="{cx}" y="{top}" text-anchor="middle" font-size="14" font-weight="600" fill="{ink}">{name}'
               + (f' <tspan font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-weight="400" font-size="12">{mono}</tspan>' if mono else "") + '</text>')
    for i, line in enumerate(lines):
        out.append(f'<text x="{cx}" y="{top + 20 + 16 * i}" text-anchor="middle" font-size="12" fill="{ink}">{line}</text>')

def arrow(x1, y1, x2, y2, both=False, dashed=False):
    dash = ' stroke-dasharray="5 4"' if dashed else ""
    start = ' marker-start="url(#a)"' if both else ""
    out.append(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="#6b6f76" stroke-width="1.25"{dash} marker-end="url(#a)"{start}/>')

def label(x, y, text, anchor="middle"):
    out.append(f'<text x="{x}" y="{y}" text-anchor="{anchor}" font-size="11.5" fill="#55595f">{text}</text>')

W, H = 1000, 716
# Row 1: front ends
box(40, 30, 270, 64, 1, "Terminal REPL", ["you type, it streams back"], mono="src/chat.js")
box(380, 30, 270, 64, 3, "RPC front end", ["devpilot --rpc"], mono="src/rpc.js")
box(730, 30, 230, 64, 3, "VS Code extension", ["chat panel · diff review"])
arrow(652, 62, 728, 62, both=True); label(690, 54, "JSON lines")
# Row 2: app core + storage
box(40, 134, 610, 64, 1, "App core", ["startup (settings, MCP servers, agents) · turns · sessions · slash commands"], mono="src/app.js")
box(730, 134, 230, 64, 1, ".devpilot/", ["session logs · settings · agents"], cyl=True)
arrow(175, 94, 175, 132); arrow(515, 94, 515, 132)
arrow(650, 166, 728, 166)
# Row 3: agent loop + LLM
box(40, 238, 610, 80, 1, "Agent loop", ["stream the reply → run its tool calls → send the results back → repeat",
                                          "compaction near the context limit · parallel read-only calls · loop detection"], mono="src/agent.js", strong=True)
box(730, 238, 230, 80, 0, "LLM", ["any tool-calling model", "via OpenRouter"])
arrow(345, 198, 345, 236)
arrow(652, 278, 728, 278, both=True); label(690, 270, "streamed")
# Row 4: the safety pipeline every call goes through
out.append('<rect x="40" y="356" width="920" height="44" rx="8" fill="#f7f7f8" stroke="#b9bcc2" stroke-width="1.25"/>')
out.append('<text x="500" y="383" text-anchor="middle" font-size="12.5" fill="#2b2b30"><tspan font-weight="600">Every tool call:</tspan> schema check → plan-mode gate → deny / allow rules → your approval (with a diff) → checkpoint for /undo</text>')
arrow(345, 318, 345, 354)
# Row 5: tools
tools = [
    (1, "File tools", ["read · list · grep", "write · edit"]),
    (1, "Shell", ["host or Docker sandbox", "timeout · deny list"]),
    (2, "Todo &amp; plan", ["todo_write", "exit_plan_mode"]),
    (3, "MCP tools", ["mcp__server__tool", "from any MCP server"]),
    (3, "task", ["starts a sub-agent,", "gets its report back"]),
]
for i, (tier, name, lines) in enumerate(tools):
    x = 40 + i * 188
    box(x, 438, 168, 72, tier, name, lines)
    arrow(x + 84, 400, x + 84, 436)
# Row 6: outside the loop
box(604, 548, 168, 72, 0, "MCP servers", ["GitHub, databases, …", "stdio or HTTP"], cyl=True)
box(792, 548, 168, 72, 3, "Sub-agents", ["fresh context,", "restricted tools"])
arrow(688, 512, 688, 546, both=True); arrow(876, 510, 876, 546)
# Legend
legend = [(1, "Tier 1 · the minimum viable agent"), (2, "Tier 2 · make it good"), (3, "Tier 3 · MCP, sub-agents, VS Code"), (0, "outside DevPilot")]
out.append('<text x="40" y="560" font-size="12.5" font-weight="600" fill="#2b2b30">Colour = the tier that added it</text>')
for i, (tier, text) in enumerate(legend):
    fill, stroke, _ = T[tier]
    y = 576 + i * 22
    out.append(f'<rect x="40" y="{y}" width="16" height="14" rx="3" fill="{fill}" stroke="{stroke}"/>')
    out.append(f'<text x="64" y="{y + 11}" font-size="12" fill="#2b2b30">{text}</text>')
out.append('<text x="40" y="684" font-size="11.5" fill="#55595f">Tier 2 also added context management, prompt caching, session resume,</text>')
out.append('<text x="40" y="700" font-size="11.5" fill="#55595f">git and checkpoints inside the core boxes.</text>')

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="DevPilot architecture: front ends, app core, agent loop, safety pipeline, tools, MCP servers and sub-agents" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif">
<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6b6f76"/></marker></defs>
<rect width="{W}" height="{H}" rx="12" fill="#ffffff"/>
{chr(10).join(out)}
</svg>
'''
open(__import__("os").path.join(__import__("os").path.dirname(__file__), "architecture.svg"), "w").write(svg)
