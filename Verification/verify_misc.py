import numpy as np
g = 9.81
print("Jump height from flight time (h = g T^2 / 8) and the error of +-1 frame in T:")
for T in (0.5, 0.6, 0.7, 0.8, 0.9):
    h = g*T*T/8
    # brute-force check with a ballistic simulation
    v = g*T/2; dt = 1e-5; y = 0; vy = v; t = 0; hmax = 0
    while t < T: y += vy*dt; vy -= g*dt; t += dt; hmax = max(hmax, y)
    e60, e120, e240 = (g*T/4*(1/f) for f in (60, 120, 240))
    print(f"  T={T:.1f}s  h={h:.3f} m  sim={hmax:.3f} m  dh per frame: 60fps {e60*100:.1f} cm, 120fps {e120*100:.1f} cm, 240fps {e240*100:.1f} cm")
def lum(hexs):
    c = [int(hexs[i:i+2], 16)/255 for i in (1, 3, 5)]
    c = [x/12.92 if x <= 0.04045 else ((x+0.055)/1.055)**2.4 for x in c]
    return 0.2126*c[0] + 0.7152*c[1] + 0.0722*c[2]
def blend(fg, bg, a):
    f = [int(fg[i:i+2], 16) for i in (1, 3, 5)]; b = [int(bg[i:i+2], 16) for i in (1, 3, 5)]
    return "#" + "".join(f"{round(a*x+(1-a)*y):02X}" for x, y in zip(f, b))
def cr(a, b): la, lb = sorted([lum(a), lum(b)], reverse=True); return (la+0.05)/(lb+0.05)
bg = "#050814"
print("\nWCAG contrast against #050814:")
for name, col in [("accent #FF007F", "#FF007F"), ("active #FF1493", "#FF1493"), ("white", "#FFFFFF"), ("cyan #00F0FF", "#00F0FF"),
                  ("fault #FF3B1A", "#FF3B1A"), ("court line pink 72%", blend("#FF007F", bg, 0.72)), ("text.secondary white 64%", blend("#FFFFFF", bg, 0.64)),
                  ("raised #0A0F24", "#0A0F24")]:
    print(f"  {name:26s} {cr(col, bg):5.2f}:1")
print(f"  pink on #0A0F24            {cr('#FF007F', '#0A0F24'):5.2f}:1")
print(f"  cyan vs pink luminance ratio {cr('#00F0FF', '#FF007F'):.2f}:1")
import colorsys
for n, h in (("#FF007F", "#FF007F"), ("#FF3B1A", "#FF3B1A")):
    r, gg, b = (int(h[i:i+2], 16)/255 for i in (1, 3, 5)); print(f"  hue {n}: {colorsys.rgb_to_hsv(r, gg, b)[0]*360:.1f} deg")
print("\nChrome budget (pt^2):")
for dev, W, H, tl in (("13in", 1376, 1032, 56), ("11in", 1210, 834, 44)):
    strip, rail, cluster = 32*W, 64*(H-32), np.pi*132**2/4; tlarea = tl*(W-64)
    print(f"  {dev}: live solo {(strip+rail+cluster)/(W*H)*100:.1f}%  analysis {(strip+rail+tlarea)/(W*H)*100:.1f}%  (timeline {tl} pt)")
