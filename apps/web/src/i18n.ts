/** 轻量 i18n：静态导入两份 locale（打包体积小），t() 支持点路径 + {var} 插值。
 *  默认 zh-CN；语言偏好持久化在 localStorage，语言切换即时生效。 */
import { useCallback, useState } from "react";
import zhCN from "./locales/zh-CN.json";
import en from "./locales/en.json";

export type Lang = "zh-CN" | "en";

const DICTS: Record<Lang, unknown> = { "zh-CN": zhCN, en };

const LANG_KEY = "dataNews.lang";

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(LANG_KEY) as Lang | null;
    if (saved === "zh-CN" || saved === "en") return saved;
  } catch { /* no storage */ }
  return "zh-CN"; // 默认中文
}

type Dict = Record<string, unknown>;

function lookup(dict: Dict, key: string): string | undefined {
  let cur: unknown = dict;
  for (const part of key.split(".")) {
    if (cur && typeof cur === "object" && part in (cur as Dict)) {
      cur = (cur as Dict)[part];
    } else {
      return undefined;
    }
  }
  return typeof cur === "string" ? cur : undefined;
}

export function useI18n() {
  const [lang, setLangState] = useState<Lang>(initialLang);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>): string => {
      let text = lookup(DICTS[lang] as Dict, key) ?? lookup(DICTS["zh-CN"] as Dict, key) ?? key;
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
        }
      }
      return text;
    },
    [lang]
  );

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try { localStorage.setItem(LANG_KEY, l); } catch { /* ignore */ }
  }, []);

  return { lang, setLang, t };
}
