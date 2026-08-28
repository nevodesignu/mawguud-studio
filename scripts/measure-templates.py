# -*- coding: utf-8 -*-
"""Exact geometry of the Mawguud production templates: a small PDF content-stream
interpreter (CTM-aware, bezier-sampling) -> board / bolts / divider in mm."""
import glob, os, json, re, math
import pikepdf

MM = 72 / 25.4
ROOT = "C:/Users/user/AppData/Local/Temp/claude/C--Users-user-Downloads-Prepbased-Site-master/96634259-1e10-4ef7-831a-d351002090ec/scratchpad/tpl/Mawguud Signs Templates"

NUM = re.compile(rb"[-+]?\d*\.?\d+")

def tokenize(data):
    toks, i, n = [], 0, len(data)
    while i < n:
        ch = data[i:i+1]
        if ch in b" \t\r\n":
            i += 1; continue
        if ch == b"%":
            while i < n and data[i:i+1] not in b"\r\n": i += 1
            continue
        if ch in b"/[]<>(){}":
            if ch == b"(":  # string
                d = 1; i += 1
                while i < n and d:
                    if data[i:i+1] == b"\\": i += 2; continue
                    if data[i:i+1] == b"(": d += 1
                    elif data[i:i+1] == b")": d -= 1
                    i += 1
                continue
            if ch == b"/":
                j = i + 1
                while j < n and data[j:j+1] not in b" \t\r\n/[]<>(){}": j += 1
                toks.append(("name", data[i:j].decode("latin1"))); i = j; continue
            i += 1; continue
        j = i
        while j < n and data[j:j+1] not in b" \t\r\n/[]<>(){}%": j += 1
        word = data[i:j]
        if NUM.fullmatch(word):
            toks.append(("num", float(word)))
        else:
            toks.append(("op", word.decode("latin1")))
        i = j
    return toks

def mat_mul(a, b):
    (a0,a1,a2,a3,a4,a5), (b0,b1,b2,b3,b4,b5) = a, b
    return (a0*b0+a1*b2, a0*b1+a1*b3, a2*b0+a3*b2, a2*b1+a3*b3, a4*b0+a5*b2+b4, a4*b1+a5*b3+b5)

def apply(m, x, y):
    return (m[0]*x + m[2]*y + m[4], m[1]*x + m[3]*y + m[5])

def bezier(p0, p1, p2, p3, steps=24):
    out = []
    for k in range(1, steps + 1):
        t = k / steps; u = 1 - t
        out.append((u*u*u*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t*t*t*p3[0],
                    u*u*u*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t*t*t*p3[1]))
    return out

def shapes_of(page):
    c = page.get("/Contents")
    data = c.read_bytes() if hasattr(c, "read_bytes") else b"".join(x.read_bytes() for x in c)
    toks = tokenize(data)
    ctm = (1,0,0,1,0,0); stack = []
    ops = []
    cur = []          # device-space points of current subpath
    subpaths = []     # finished subpaths of the current path
    start = None; cp = None
    shapes = []
    for kind, val in toks:
        if kind == "num": ops.append(val); continue
        if kind == "name": ops = []; continue
        op = val
        if op == "q": stack.append(ctm)
        elif op == "Q": ctm = stack.pop() if stack else ctm
        elif op == "cm" and len(ops) >= 6:
            ctm = mat_mul(tuple(ops[-6:]), ctm)
        elif op == "m" and len(ops) >= 2:
            if cur: subpaths.append(cur)
            cp = (ops[-2], ops[-1]); start = cp; cur = [apply(ctm, *cp)]
        elif op == "l" and len(ops) >= 2:
            cp = (ops[-2], ops[-1]); cur.append(apply(ctm, *cp))
        elif op in ("c", "v", "y") and cp is not None:
            if op == "c" and len(ops) >= 6:
                p1, p2, p3 = (ops[-6], ops[-5]), (ops[-4], ops[-3]), (ops[-2], ops[-1])
            elif op == "v" and len(ops) >= 4:
                p1, p2, p3 = cp, (ops[-4], ops[-3]), (ops[-2], ops[-1])
            elif op == "y" and len(ops) >= 4:
                p1, p3 = (ops[-4], ops[-3]), (ops[-2], ops[-1]); p2 = p3
            else:
                ops = []; continue
            for pt in bezier(cp, p1, p2, p3):
                cur.append(apply(ctm, *pt))
            cp = p3
        elif op == "h":
            if cur and start is not None:
                cur.append(apply(ctm, *start))
        elif op == "re" and len(ops) >= 4:
            x, y, w, h = ops[-4:]
            if cur: subpaths.append(cur); cur = []
            subpaths.append([apply(ctm, x, y), apply(ctm, x+w, y), apply(ctm, x+w, y+h), apply(ctm, x, y+h), apply(ctm, x, y)])
            cp = (x, y); start = cp
        elif op in ("S","s","f","F","f*","B","B*","b","b*","n"):
            if cur: subpaths.append(cur)
            for sp in subpaths:
                if len(sp) >= 2:
                    xs = [p[0] for p in sp]; ys = [p[1] for p in sp]
                    shapes.append({"x0": min(xs), "x1": max(xs), "y0": min(ys), "y1": max(ys), "n": len(sp), "painted": op != "n"})
            cur = []; subpaths = []; cp = None; start = None
        elif op == "W" or op == "W*":
            pass  # clip - keep path for the following painting op
        ops = []
    return shapes

def measure(path):
    pdf = pikepdf.open(path)
    page = pdf.pages[0]
    shapes = [s for s in shapes_of(page) if s["painted"]]
    for s in shapes:
        s["w"] = (s["x1"] - s["x0"]) / MM
        s["h"] = (s["y1"] - s["y0"]) / MM
        s["area"] = s["w"] * s["h"]
    shapes = [s for s in shapes if s["w"] > 0.05 and s["h"] > 0.05]
    if not shapes:
        return {"file": path, "error": "no shapes"}
    board = max(shapes, key=lambda s: s["area"])
    bw, bh = board["w"], board["h"]
    def rel(s):
        return {"x0": (s["x0"] - board["x0"]) / MM, "x1": (s["x1"] - board["x0"]) / MM,
                "y0": (board["y1"] - s["y1"]) / MM, "y1": (board["y1"] - s["y0"]) / MM,
                "w": s["w"], "h": s["h"], "n": s["n"]}
    bolts, divs, rest = [], [], []
    for s in shapes:
        if s is board: continue
        r = rel(s)
        ratio = r["w"] / r["h"] if r["h"] else 99
        if 0.8 < ratio < 1.25 and r["w"] < 30 and r["n"] > 8:
            bolts.append(r)
        elif (ratio > 6 or ratio < 1/6) and max(r["w"], r["h"]) > 0.12 * min(bw, bh):
            divs.append(r)
        else:
            rest.append(r)
    return {
        "file": os.path.relpath(path, ROOT).replace("\\", "/"),
        "board": [round(bw, 2), round(bh, 2)],
        "bolts": sorted([[round((b["x0"]+b["x1"])/2, 2), round((b["y0"]+b["y1"])/2, 2), round((b["w"]+b["h"])/2, 2)] for b in bolts]),
        "dividers": [{"vertical": d["h"] > d["w"], "cx": round((d["x0"]+d["x1"])/2, 2), "cy": round((d["y0"]+d["y1"])/2, 2),
                      "len": round(max(d["w"], d["h"]), 2), "thick": round(min(d["w"], d["h"]), 2)} for d in divs],
        "other": len(rest),
    }

rows = []
for f in sorted(glob.glob(os.path.join(ROOT, "**", "*.ai"), recursive=True)):
    try: rows.append(measure(f))
    except Exception as e: rows.append({"file": os.path.basename(f), "error": f"{type(e).__name__}: {e}"})
print(json.dumps(rows, indent=1, ensure_ascii=False))

# ---- compact summary ----
def dedupe(pts, tol=0.3):
    out = []
    for p in pts:
        if not any(abs(p[0]-q[0]) < tol and abs(p[1]-q[1]) < tol for q in out):
            out.append(p)
    return out

print("\n=== SUMMARY (mm, path centrelines, origin = board top-left, y down) ===")
print(f"{'file':38} {'board':>14} {'bolts':>6} {'dia':>6} {'insetX':>7} {'insetY':>7} {'divider':>32}")
for r in rows:
    if "error" in r:
        print(f"{r['file'][:38]:38} ERROR {r['error']}"); continue
    b = dedupe(r["bolts"])
    bw, bh = r["board"]
    dia = round(sum(x[2] for x in b)/len(b), 2) if b else 0
    ix = round(min(x[0] for x in b), 2) if b else 0
    iy = round(min(x[1] for x in b), 2) if b else 0
    dtxt = ""
    for d in r["dividers"]:
        dtxt += f"{'V' if d['vertical'] else 'H'} c=({d['cx']},{d['cy']}) len={d['len']} th={d['thick']} "
    print(f"{r['file'][:38]:38} {str(bw)+'x'+str(bh):>14} {len(b):>6} {dia:>6} {ix:>7} {iy:>7} {dtxt.strip():>32}")
