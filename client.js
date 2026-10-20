/* dsh-workbuddy-usage · client half
 *
 * Codex 风格用量条：停靠在对话输入区（conversation.input.dock），
 * 常显「今日 · xxx 万 tokens」，点开是同源拉取的详情面板：
 * 总 Token（万/亿）、输入输出、请求/错误、积分、缓存命中、按模型占比、时序柱状图。
 *
 * 数据：GET /dsh-workbuddy-usage/api/usage?scope=today|7d|30d|all[&refresh=1]
 * 该路由由宿主半侧注册在 DSH 自己的 webServer 上（同源，绕过面板的 CORS/CSP 限制）。
 */
window.__ModuleLoader__.load({
  id: "dsh-workbuddy-usage",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");
    var h = react.createElement;

    var API = "/dsh-workbuddy-usage/api/usage";
    var SCOPES = [
      { id: "today", label: "今日" },
      { id: "7d", label: "近 7 天" },
      { id: "30d", label: "近 30 天" },
      { id: "all", label: "全部" }
    ];
    var PANEL_WIDTH = 384;

    /* ---------------- 主题 ---------------- */

    var DARK = {
      card: "rgba(22,23,26,0.985)",
      border: "rgba(255,255,255,0.10)",
      inner: "rgba(255,255,255,0.045)",
      text: "#ededed",
      sub: "rgba(237,237,237,0.56)",
      faint: "rgba(237,237,237,0.34)",
      track: "rgba(255,255,255,0.08)",
      accent: "#19c37d",
      accent2: "#5b8def",
      warn: "#f0a02a",
      err: "#f05252",
      shadow: "0 20px 56px rgba(0,0,0,0.62)"
    };
    var LIGHT = {
      card: "rgba(255,255,255,0.99)",
      border: "rgba(16,24,40,0.10)",
      inner: "rgba(16,24,40,0.038)",
      text: "#12141a",
      sub: "rgba(18,20,26,0.56)",
      faint: "rgba(18,20,26,0.34)",
      track: "rgba(16,24,40,0.075)",
      accent: "#0f9f6e",
      accent2: "#3b6fe0",
      warn: "#b45309",
      err: "#d13b3b",
      shadow: "0 18px 48px rgba(15,23,42,0.20)"
    };

    function parseRgb(value) {
      var m = String(value || "").match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      var parts = m[1].split(",").map(function (x) { return parseFloat(x); });
      if (parts.length < 3 || parts.some(function (x) { return !isFinite(x); })) return null;
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    }

    function themeFor(node) {
      try {
        var probe = node || document.body;
        var seen = 0;
        while (probe && seen < 8) {
          var c = parseRgb(getComputedStyle(probe).backgroundColor);
          if (c && c.a > 0.15) {
            var lum = (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
            return lum > 0.62 ? LIGHT : DARK;
          }
          probe = probe.parentElement;
          seen++;
        }
        var html = parseRgb(getComputedStyle(document.documentElement).backgroundColor);
        if (html && html.a > 0.15) {
          var l2 = (0.299 * html.r + 0.587 * html.g + 0.114 * html.b) / 255;
          return l2 > 0.62 ? LIGHT : DARK;
        }
        return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? LIGHT : DARK;
      } catch (e) {
        return DARK;
      }
    }

    /* ---------------- 数字格式 ---------------- */

    function trim(v, digits) {
      var s = v.toFixed(digits);
      if (s.indexOf(".") >= 0) s = s.replace(/0+$/, "").replace(/\.$/, "");
      return s;
    }

    /** 未破亿一律「万」，破亿后「亿」。 */
    function tokParts(n) {
      n = Number(n) || 0;
      if (n >= 1e8) {
        var y = n / 1e8;
        return { value: trim(y, y >= 100 ? 0 : y >= 10 ? 2 : 3), unit: "亿" };
      }
      var w = n / 1e4;
      var digits = w >= 1000 ? 0 : w >= 100 ? 1 : w >= 10 ? 1 : 2;
      var text = trim(w, digits);
      if (Number(text) >= 10000) {
        // 差一点点就破亿时，进位后按亿显示（避免出现「10000 万」）
        return { value: trim(n / 1e8, 2), unit: "亿" };
      }
      return { value: text, unit: "万" };
    }

    function tokText(n) {
      var p = tokParts(n);
      return p.value + " " + p.unit;
    }

    function intText(n) {
      return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }

    function creditText(n) {
      var v = Number(n) || 0;
      return v >= 1000 ? intText(v) : v.toFixed(2);
    }

    /** 每百万 tokens 的积分单价：小于 1 保留 3 位，其余 2 位。 */
    function per1mText(n) {
      var v = Number(n) || 0;
      if (v <= 0) return "0";
      if (v >= 100) return String(Math.round(v));
      if (v >= 10) return v.toFixed(1);
      if (v >= 1) return v.toFixed(2);
      return v.toFixed(3);
    }

    function pctText(n) {
      return (Number(n) || 0).toFixed(1) + "%";
    }

    function clockText(ts) {
      try {
        var d = new Date(ts);
        function p(x) { return x < 10 ? "0" + x : String(x); }
        return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
      } catch (e) {
        return "--:--:--";
      }
    }

    function bucketLabel(t) {
      if (!t) return "";
      var s = String(t);
      var m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})/);
      if (m) return m[2] + "/" + m[3] + " " + m[4] + "时";
      m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (m) return m[2] + "/" + m[3];
      return s;
    }

    /** 把任意长度的时序压到至多 max 根柱子（相邻求和）。 */
    function condense(series, max) {
      var src = Array.isArray(series) ? series : [];
      if (src.length <= max) {
        return src.map(function (p) {
          return { label: bucketLabel(p.t), tokens: p.totalTokens, requests: p.requests };
        });
      }
      var size = Math.ceil(src.length / max);
      var out = [];
      for (var i = 0; i < src.length; i += size) {
        var chunk = src.slice(i, i + size);
        var tokens = 0, requests = 0;
        for (var j = 0; j < chunk.length; j++) {
          tokens += Number(chunk[j].totalTokens) || 0;
          requests += Number(chunk[j].requests) || 0;
        }
        out.push({ label: bucketLabel(chunk[0].t), tokens: tokens, requests: requests });
      }
      return out;
    }

    /* ---------------- 数据 ---------------- */

    function fetchUsage(scope, refresh) {
      var url = API + "?scope=" + encodeURIComponent(scope) + (refresh ? "&refresh=1" : "");
      return fetch(url, { headers: { accept: "application/json" }, cache: "no-store" }).then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      });
    }

    /* ---------------- 小组件 ---------------- */

    function Stat(props) {
      var t = props.t;
      return h(
        "div",
        {
          style: {
            flex: "1 1 0",
            minWidth: 0,
            padding: "9px 10px",
            borderRadius: "9px",
            background: t.inner,
            border: "1px solid " + t.border
          }
        },
        h("div", { style: { fontSize: "10px", letterSpacing: ".04em", color: t.sub, marginBottom: "3px" } }, props.label),
        h(
          "div",
          { style: { display: "flex", alignItems: "baseline", gap: "3px", color: t.text } },
          h("span", { style: { fontSize: "18px", fontWeight: 650, lineHeight: "20px" } }, props.value),
          props.unit ? h("span", { style: { fontSize: "11px", color: t.sub } }, props.unit) : null
        ),
        props.hint ? h("div", { style: { fontSize: "10px", color: t.faint, marginTop: "3px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, props.hint) : null
      );
    }

    function ModelRow(props) {
      var t = props.t;
      var name = String(props.model.key || "").replace(/^cn:/, "");
      var tokensN = Number(props.model.totalTokens) || 0;
      var creditsN = Number(props.model.credits) || 0;
      var per1m =
        props.model.creditsPer1M != null && props.model.creditsPer1M > 0
          ? props.model.creditsPer1M
          : tokensN > 0
            ? creditsN / (tokensN / 1e6)
            : 0;
      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "4px" } },
        h(
          "div",
          { style: { display: "flex", justifyContent: "space-between", gap: "8px", fontSize: "11px", color: t.text } },
          h(
            "span",
            { style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: props.model.key },
            name,
            h("span", { style: { color: t.faint, marginLeft: "6px" } }, intText(props.model.requests) + " 次")
          ),
          h(
            "span",
            { style: { flex: "none", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "1px" } },
            h("span", { style: { color: t.sub, fontVariantNumeric: "tabular-nums" } }, tokText(tokensN)),
            h(
              "span",
              {
                title:
                  "每百万 tokens 消耗 " + per1mText(per1m) + " 积分 · 该区间共 " +
                  creditText(creditsN) + " 积分 / " + tokText(tokensN) + " tokens",
                style: { color: per1m > 0 ? t.sub : t.faint, fontSize: "9.5px", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }
              },
              (per1m > 0 ? per1mText(per1m) + " 积分/M" : tokensN > 0 ? "免费" : "—")
            )
          )
        ),
        h(
          "div",
          { style: { height: "4px", borderRadius: "999px", background: t.track, overflow: "hidden" } },
          h("div", {
            style: {
              width: Math.max(2, Math.min(100, Math.round((props.share || 0) * 100))) + "%",
              height: "100%",
              borderRadius: "999px",
              background: props.color
            }
          })
        )
      );
    }

    function Spark(props) {
      var t = props.t;
      var bars = props.bars || [];
      var max = 0;
      for (var i = 0; i < bars.length; i++) max = Math.max(max, bars[i].tokens);
      if (!bars.length || max <= 0) {
        return h("div", { style: { fontSize: "11px", color: t.faint, padding: "6px 0" } }, "该区间暂无时序数据");
      }
      return h(
        "div",
        { style: { display: "flex", alignItems: "flex-end", gap: "2px", height: "52px" } },
        bars.map(function (b, idx) {
          var ratio = b.tokens / max;
          return h("div", {
            key: idx,
            title: b.label + " · " + tokText(b.tokens) + " tokens · " + intText(b.requests) + " 次",
            style: {
              flex: "1 1 0",
              minWidth: "2px",
              height: Math.max(3, Math.round(ratio * 52)) + "px",
              borderRadius: "2px 2px 0 0",
              background: ratio > 0.66 ? t.accent : ratio > 0.33 ? t.accent2 : t.track
            }
          });
        })
      );
    }

    /* ---------------- 主组件 ---------------- */

    function UsageDock(props) {
      var wide = !props || props.wide !== false;
      var openPair = react.useState(false);
      var open = openPair[0], setOpen = openPair[1];
      var scopePair = react.useState("today");
      var scope = scopePair[0], setScope = scopePair[1];
      var dataPair = react.useState(null);
      var data = dataPair[0], setData = dataPair[1];
      var errPair = react.useState(null);
      var err = errPair[0], setErr = errPair[1];
      var loadPair = react.useState(true);
      var loading = loadPair[0], setLoading = loadPair[1];
      var anchorPair = react.useState({ left: 16, bottom: 120 });
      var anchor = anchorPair[0], setAnchor = anchorPair[1];

      var pillRef = react.useRef(null);
      var panelRef = react.useRef(null);
      var tuneRef = react.useRef(0);
      var scopeRef = react.useRef(scope);
      scopeRef.current = scope;

      var load = react.useCallback(function (refresh) {
        setLoading(true);
        return fetchUsage(scopeRef.current, refresh)
          .then(function (json) {
            if (json && json.ok) {
              setData(json);
              setErr(json.stale && json.error ? "（离线缓存）" + json.error : null);
            } else {
              setErr((json && json.error) || "未知错误");
            }
          })
          .catch(function (e) {
            setErr(String((e && e.message) || e));
          })
          .then(function () {
            setLoading(false);
          });
      }, []);

      react.useEffect(function () {
        load(false);
      }, [scope]);

      react.useEffect(function () {
        var period = open ? 30000 : 180000;
        var timer = setInterval(function () { load(true); }, period);
        return function () { clearInterval(timer); };
      }, [scope, open, load]);

      var measure = react.useCallback(function () {
        var el = pillRef.current;
        if (!el) return;
        var rect = el.getBoundingClientRect();
        var left = rect.right + 10;
        if (left + PANEL_WIDTH > window.innerWidth - 12) left = window.innerWidth - PANEL_WIDTH - 12;
        if (left < 12) left = 12;
        tuneRef.current = 0;
        setAnchor({ left: left, bottom: window.innerHeight - rect.bottom });
      }, []);

      /* 兜底：若面板所在的定位上下文不是视口（祖先带 transform/filter 时
       * position:fixed 会以该祖先为包含块），按真实渲染位置把面板拉回视口内。 */
      react.useEffect(function () {
        if (!open) {
          tuneRef.current = 0;
          return;
        }
        var el = panelRef.current;
        if (!el) return;
        var box = el.getBoundingClientRect();
        var maxRight = window.innerWidth - 8;
        var maxBottom = window.innerHeight - 8;
        var dx = 0;
        var dy = 0;
        if (box.right > maxRight) dx = maxRight - box.right;
        else if (box.left < 8) dx = 8 - box.left;
        if (box.bottom > maxBottom) dy = maxBottom - box.bottom;
        if (box.top < 8 && dy === 0) dy = 8 - box.top;
        if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) return;
        if (Math.abs(tuneRef.current) > 600) return;
        tuneRef.current += Math.abs(dx) + Math.abs(dy);
        setAnchor(function (a) {
          return { left: a.left + dx, bottom: a.bottom - dy };
        });
      }, [open, data, err, scope, loading]);

      react.useEffect(function () {
        if (!open) return undefined;
        measure();
        function onDown(event) {
          var p = panelRef.current;
          var b = pillRef.current;
          if (p && p.contains(event.target)) return;
          if (b && b.contains(event.target)) return;
          setOpen(false);
        }
        function onKey(event) {
          if (event.key === "Escape") setOpen(false);
        }
        document.addEventListener("mousedown", onDown, true);
        document.addEventListener("keydown", onKey);
        window.addEventListener("resize", measure);
        window.addEventListener("scroll", measure, true);
        return function () {
          document.removeEventListener("mousedown", onDown, true);
          document.removeEventListener("keydown", onKey);
          window.removeEventListener("resize", measure);
          window.removeEventListener("scroll", measure, true);
        };
      }, [open, measure]);

      var t = themeFor(pillRef.current);
      var totals = (data && data.totals) || null;
      var tokens = totals ? tokParts(totals.totalTokens) : { value: "—", unit: "" };
      var scopeLabel = (SCOPES.filter(function (s) { return s.id === scope; })[0] || SCOPES[0]).label;

      var valueText = totals ? tokens.value + " " + tokens.unit : "—";
      var acctInfo = data && data.account && data.account.ok ? data.account.totals : null;
      var pill = h(
        "div",
        { ref: pillRef, style: { display: "flex", width: "100%", minWidth: "0" } },
        h(
          "button",
          {
            type: "button",
            "data-dsh-wb-usage": "entry",
            "aria-haspopup": "dialog",
            "aria-expanded": open ? "true" : "false",
            "aria-label": "WorkBuddy 使用量",
            title:
              "WorkBuddy 使用量 · 点击查看明细" +
              (acctInfo ? " · 剩余 " + intText(acctInfo.credits) + " 积分" : ""),
            onClick: function () { setOpen(!open); },
            style: {
              boxSizing: "border-box",
              display: "flex",
              alignItems: "center",
              gap: "4px",
              width: "100%",
              minWidth: "0",
              height: "36px",
              margin: "0",
              padding: "0 8px",
              border: "none",
              borderRadius: "var(--dsw-radius-md, 8px)",
              background: "transparent",
              color: "var(--dsw-alias-label-primary, inherit)",
              font: "inherit",
              lineHeight: "22px",
              textAlign: "left",
              cursor: "pointer",
              appearance: "none"
            }
          },
          h(
            "span",
            { style: { display: "inline-flex", flex: "none", width: "16px", height: "16px", alignItems: "center", justifyContent: "center", color: "inherit" } },
            h(
              "svg",
              { width: "16", height: "16", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" },
              h("path", { d: "M2.75 13.25h10.5" }),
              h("path", { d: "M4.75 13.25V9.25" }),
              h("path", { d: "M8 13.25V5.5" }),
              h("path", { d: "M11.25 13.25V10.5" })
            )
          ),
          wide
            ? h("span", { style: { flex: "1 1 auto", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, "使用量")
            : null,
          wide
            ? h(
                "span",
                {
                  style: {
                    flex: "none",
                    marginLeft: "auto",
                    paddingLeft: "6px",
                    color: "var(--dsw-alias-label-secondary, rgba(128,128,128,0.9))",
                    fontVariantNumeric: "tabular-nums",
                    whiteSpace: "nowrap"
                  }
                },
                valueText
              )
            : null
        )
      );

      var panel = null;
      if (open) {
        var models = (data && data.models) || [];
        var bars = condense((data && data.series) || [], 34);
        var acct = data && data.account && data.account.ok ? data.account : null;
        var acctTotals = acct ? acct.totals : null;
        var acctRows = acct && Array.isArray(acct.accounts) ? acct.accounts : [];
        var creditPerM = totals && totals.totalTokens > 0 ? (totals.credits / (totals.totalTokens / 1e6)) : 0;
        var inTok = totals ? totals.promptTokens : 0;
        var outTok = totals ? totals.completionTokens : 0;
        var sumTok = inTok + outTok || 1;

        var creditRatio = acctTotals && acctTotals.creditsTotal > 0
          ? Math.max(0, Math.min(1, acctTotals.credits / acctTotals.creditsTotal))
          : 0;
        var accountSection = null;
        if (acct) {
          accountSection = h(
            "div",
            { style: { marginBottom: "12px" } },
            h(
              "div",
              { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "5px" } },
              h("span", { style: { fontSize: "10.5px", color: t.sub } }, "账号额度（剩余 / 总额）"),
              h(
                "span",
                { style: { fontSize: "10.5px", fontVariantNumeric: "tabular-nums" } },
                h("span", { style: { color: t.text, fontWeight: 620 } }, intText(acctTotals.credits)),
                h("span", { style: { color: t.faint } }, " / " + intText(acctTotals.creditsTotal))
              )
            ),
            h(
              "div",
              { style: { display: "flex", height: "6px", borderRadius: "999px", overflow: "hidden", background: t.track, marginBottom: "6px" } },
              h("div", { style: { width: Math.max(1, creditRatio * 100) + "%", background: t.accent } })
            ),
            h(
              "div",
              { style: { display: "flex", justifyContent: "space-between", fontSize: "10px", color: t.faint, marginBottom: "7px" } },
              h("span", null,
                acctTotals.accounts + " 个账号 · 可用 " + intText(acctTotals.healthy) +
                (acctTotals.cooling ? " · 冷却 " + intText(acctTotals.cooling) : "") +
                (acctTotals.disabled ? " · 禁用 " + intText(acctTotals.disabled) : "")),
              h("span", null, "已用 " + pctText(100 - creditRatio * 100))
            ),
            h(
              "div",
              { style: { display: "flex", flexDirection: "column", gap: "5px", maxHeight: "156px", overflowY: "auto", paddingRight: "2px" } },
              acctRows.slice(0, 12).map(function (a, idx) {
                var ratio = a.creditsTotal > 0 ? Math.max(0, Math.min(1, a.credits / a.creditsTotal)) : 0;
                var dot = a.disabled ? t.faint : a.cooling ? t.warn : t.accent;
                var tip = [];
                if (a.cooling && a.reason) tip.push("冷却：" + a.reason + (a.until ? "（至 " + a.until + "）" : ""));
                if (a.lastModel) tip.push("最近模型 " + a.lastModel);
                if (a.requests) tip.push("累计 " + intText(a.requests) + " 次请求 / " + tokText(a.totalTokens) + " tokens");
                if (a.earliestExpiry) tip.push("最早到期 " + a.earliestExpiry + "（余 " + intText(a.earliestRemaining) + "）");
                return h(
                  "div",
                  {
                    key: a.uid || idx,
                    title: tip.join(" · "),
                    style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "10.5px" }
                  },
                  h("span", { style: { width: "5px", height: "5px", borderRadius: "50%", flex: "none", background: dot } }),
                  h("span", {
                    style: {
                      flex: "1 1 auto",
                      minWidth: "0",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      color: a.disabled ? t.faint : t.text
                    }
                  }, a.nickname),
                  h(
                    "span",
                    { style: { flex: "none", width: "44px", height: "4px", borderRadius: "999px", background: t.track, overflow: "hidden" } },
                    h("span", { style: { display: "block", height: "100%", width: Math.max(2, ratio * 100) + "%", background: dot } })
                  ),
                  h("span", {
                    style: { flex: "none", minWidth: "64px", textAlign: "right", color: t.sub, fontVariantNumeric: "tabular-nums" }
                  }, intText(a.credits) + " / " + intText(a.creditsTotal))
                );
              })
            )
          );
        } else if (data && data.account && data.account.error) {
          accountSection = h("div", { style: { fontSize: "10px", color: t.faint, marginBottom: "10px" } },
            "账号额度不可用：" + data.account.error);
        }

        panel = h(
          "div",
          {
            ref: panelRef,
            style: {
              position: "fixed",
              left: anchor.left + "px",
              bottom: anchor.bottom + "px",
              width: PANEL_WIDTH + "px",
              maxWidth: "calc(100vw - 24px)",
              maxHeight: "min(70vh, 560px)",
              overflowY: "auto",
              zIndex: 2147483000,
              boxSizing: "border-box",
              padding: "12px 12px 10px",
              borderRadius: "13px",
              border: "1px solid " + t.border,
              background: t.card,
              color: t.text,
              boxShadow: t.shadow,
              backdropFilter: "blur(14px)",
              fontSize: "12px",
              lineHeight: "16px",
              fontFamily: "inherit"
            }
          },
          /* 标题 + 区间切换 */
          h(
            "div",
            { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "9px" } },
            h(
              "div",
              { style: { display: "flex", alignItems: "center", gap: "6px", fontWeight: 650, fontSize: "12.5px" } },
              h("span", null, "WorkBuddy 用量"),
              h("span", { style: { fontSize: "10px", fontWeight: 400, color: t.faint } },
                loading ? "刷新中…" : data ? "更新于 " + clockText(data.fetchedAt) : "")
            ),
            h(
              "div",
              { style: { display: "flex", gap: "2px", padding: "2px", borderRadius: "8px", background: t.inner } },
              SCOPES.map(function (s) {
                var active = s.id === scope;
                return h(
                  "button",
                  {
                    key: s.id,
                    onClick: function () { setScope(s.id); },
                    style: {
                      border: "0",
                      cursor: "pointer",
                      padding: "2px 7px",
                      borderRadius: "6px",
                      fontSize: "10.5px",
                      fontFamily: "inherit",
                      color: active ? (t === LIGHT ? "#fff" : "#0b0c0e") : t.sub,
                      background: active ? (t === LIGHT ? t.text : "#ededed") : "transparent",
                      transition: "background .14s ease"
                    }
                  },
                  s.label
                );
              })
            )
          ),

          err
            ? h("div", {
                style: {
                  marginBottom: "8px",
                  padding: "6px 8px",
                  borderRadius: "7px",
                  fontSize: "10.5px",
                  color: t.err,
                  background: t === LIGHT ? "rgba(209,59,59,0.08)" : "rgba(240,82,82,0.12)",
                  border: "1px solid " + (t === LIGHT ? "rgba(209,59,59,0.18)" : "rgba(240,82,82,0.25)")
                }
              }, err)
            : null,

          /* 主指标 */
          h(
            "div",
            { style: { display: "flex", alignItems: "baseline", gap: "6px", margin: "2px 0 10px" } },
            h("span", { style: { fontSize: "30px", lineHeight: "32px", fontWeight: 680, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" } }, tokens.value),
            h("span", { style: { fontSize: "14px", color: t.sub } }, tokens.unit),
            h("span", { style: { fontSize: "10.5px", color: t.faint, marginLeft: "2px" } },
              scopeLabel + "累计 tokens · 约 " + intText(totals ? totals.totalTokens : 0) + " 枚")
          ),

          /* 四宫格 */
          h(
            "div",
            { style: { display: "flex", gap: "6px", marginBottom: "6px" } },
            h(Stat, {
              t: t,
              label: "请求",
              value: intText(totals ? totals.requests : 0),
              unit: "次",
              hint: "错误 " + intText(totals ? totals.errors : 0) + " · 均延迟 " + intText(totals ? totals.avgLatencyMs : 0) + "ms"
            }),
            h(Stat, {
              t: t,
              label: "积分",
              value: creditText(totals ? totals.credits : 0),
              unit: "",
              hint: "每百万 tokens " + creditText(creditPerM)
            })
          ),
          h(
            "div",
            { style: { display: "flex", gap: "6px", marginBottom: "10px" } },
            h(Stat, {
              t: t,
              label: "缓存命中",
              value: pctText(totals ? totals.cacheHitRate : 0),
              unit: "",
              hint: "命中 " + tokText(totals ? totals.cacheHitTokens : 0)
            }),
            h(Stat, {
              t: t,
              label: "输出速度",
              value: String(Math.round(totals ? totals.tokensPerSecond : 0)),
              unit: "tok/s",
              hint: "输出共 " + tokText(outTok)
            })
          ),

          /* 输入 / 输出 占比条 */
          h(
            "div",
            { style: { marginBottom: "12px" } },
            h(
              "div",
              { style: { display: "flex", justifyContent: "space-between", fontSize: "10.5px", color: t.sub, marginBottom: "4px" } },
              h("span", null, "输入 " + tokText(inTok)),
              h("span", null, "输出 " + tokText(outTok))
            ),
            h(
              "div",
              { style: { display: "flex", height: "6px", borderRadius: "999px", overflow: "hidden", background: t.track } },
              h("div", { style: { width: Math.max(1, (inTok / sumTok) * 100) + "%", background: t.accent } }),
              h("div", { style: { flex: "1 1 auto", background: t.accent2 } })
            )
          ),

          /* 账号额度 */
          accountSection,

          /* 按模型 */
          h(
            "div",
            { style: { marginBottom: "12px" } },
            h("div", { style: { fontSize: "10.5px", color: t.sub, marginBottom: "6px" } }, "按模型 · 右列为每百万 tokens 积分"),
            models.length
              ? h(
                  "div",
                  { style: { display: "flex", flexDirection: "column", gap: "7px" } },
                  models.slice(0, 8).map(function (m, idx) {
                    return h(ModelRow, {
                      key: m.key || idx,
                      t: t,
                      model: m,
                      share: m.share,
                      color: idx === 0 ? t.accent : idx === 1 ? t.accent2 : t.track
                    });
                  })
                )
              : h("div", { style: { fontSize: "11px", color: t.faint } }, "暂无模型数据"),
            models.length > 8
              ? h("div", { style: { fontSize: "9.5px", color: t.faint, marginTop: "4px" } },
                  "另有 " + (models.length - 8) + " 个模型未显示（共 " + models.length + " 个）")
              : null
          ),

          /* 时序 */
          h(
            "div",
            { style: { marginBottom: "10px" } },
            h(
              "div",
              { style: { display: "flex", justifyContent: "space-between", fontSize: "10.5px", color: t.sub, marginBottom: "5px" } },
              h("span", null, "时序（" + (bars[0] ? bars[0].label : "-") + " → " + (bars[bars.length - 1] ? bars[bars.length - 1].label : "-") + "）"),
              h("span", { style: { color: t.faint } }, data && data.upstream && data.upstream.since ? "since " + data.upstream.since : "")
            ),
            h(Spark, { t: t, bars: bars })
          ),

          /* 底栏 */
          h(
            "div",
            { style: { display: "flex", alignItems: "center", justifyContent: "space-between", borderTop: "1px solid " + t.border, paddingTop: "7px" } },
            h("span", { style: { fontSize: "10px", color: t.faint } },
              open ? "自动刷新 30s" : "自动刷新 3 分钟"),
            h(
              "button",
              {
                onClick: function () { load(true); },
                style: {
                  border: "1px solid " + t.border,
                  background: t.inner,
                  color: t.text,
                  borderRadius: "7px",
                  padding: "3px 9px",
                  fontSize: "10.5px",
                  fontFamily: "inherit",
                  cursor: "pointer"
                }
              },
              loading ? "刷新中…" : "刷新"
            )
          )
        );
      }

      return h(
        "div",
        { style: { display: "flex", width: "100%", minWidth: "0", position: "relative" } },
        pill,
        panel
      );
    }

    var STYLE_ID = "dsh-workbuddy-usage/style";

    /* 侧边栏条目外观对齐 DSH 原生：ghost 按钮 + 原生交互色 token。 */
    var ENTRY_CSS = [
      '[data-dsh-wb-usage="entry"]{transition:background .15s var(--ds-ease-in-out,ease)}',
      '[data-dsh-wb-usage="entry"]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16))}',
      '[data-dsh-wb-usage="entry"]:active{background:var(--dsw-alias-interactive-bg-active,rgba(128,128,128,.22))}',
      '[data-dsh-wb-usage="entry"]:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe));outline-offset:-2px}'
    ].join("");

    function ensureStyle() {
      if (typeof document === "undefined") return;
      if (document.getElementById(STYLE_ID) !== null) return;
      var tag = document.createElement("style");
      tag.id = STYLE_ID;
      tag.textContent = ENTRY_CSS;
      document.head.appendChild(tag);
    }

    function apply(ctx) {
      ensureStyle();
      ctx.slots.inject("sidebar.footer.action", function () {
        return ctx.slots.register(
          { name: "sidebar.footer.action", id: "workbuddy-usage", order: 25 },
          UsageDock
        );
      });
    }

    exports.name = "dsh-workbuddy-usage";
    exports.inject = ["slots"];
    exports.apply = apply;
    /* 仅用于离线自测（宿主不读） */
    exports.__test = { tokParts: tokParts, tokText: tokText, intText: intText, condense: condense, creditText: creditText };
    return module.exports;
  }
});
