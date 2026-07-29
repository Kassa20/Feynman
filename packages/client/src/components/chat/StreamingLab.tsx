import type { DeepPartial } from "react-hook-form";
import type { LabContent } from "./ChatBot";

type Props = {
  content: DeepPartial<LabContent>;
};

export const StreamingLab = ({ content }: Props) => (
  <div className="rounded-[14px] border border-border bg-muted px-4 py-3 text-sm">
    {content.title && (
      <h1 className="mb-2 text-lg font-bold text-foreground">
        {content.title}
      </h1>
    )}
    {content.steps?.map((step, i) => (
      <div key={i} className="mb-3">
        {step?.title && (
          <h3 className="mb-1 text-sm font-bold text-foreground">
            {i + 1}. {step.title}
          </h3>
        )}
        {step?.description && (
          <p className="leading-relaxed">{step.description}</p>
        )}
      </div>
    ))}
  </div>
);
