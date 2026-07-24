import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

SyntaxHighlighter.registerLanguage("bash", bash);
SyntaxHighlighter.registerLanguage("javascript", javascript);
SyntaxHighlighter.registerLanguage("typescript", typescript);
SyntaxHighlighter.registerLanguage("python", python);
SyntaxHighlighter.registerLanguage("json", json);
SyntaxHighlighter.registerLanguage("yaml", yaml);

const registeredLanguages = new Set([
  "bash",
  "javascript",
  "typescript",
  "python",
  "json",
  "yaml",
]);

type Props = {
  language: string;
  code: string;
};

export const CodeBlock = ({ language, code }: Props) => {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-white/10">
      <div className="flex items-center justify-between bg-[#1e1e2e] px-3 py-1.5 text-xs text-white/50">
        <span>{language || "text"}</span>
        <button
          type="button"
          onClick={onCopy}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-white/50 hover:bg-white/10 hover:text-white/80"
        >
          {copied ? (
            <>
              <Check className="size-3.5" /> Copied
            </>
          ) : (
            <>
              <Copy className="size-3.5" /> Copy
            </>
          )}
        </button>
      </div>
      {registeredLanguages.has(language) ? (
        <SyntaxHighlighter
          language={language}
          style={oneDark}
          customStyle={{ margin: 0, borderRadius: 0, fontSize: "0.8125rem" }}
        >
          {code}
        </SyntaxHighlighter>
      ) : (
        <pre className="overflow-x-auto bg-[#1e1e2e] px-3 py-2.5 text-[0.8125rem] text-white/85">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
};
