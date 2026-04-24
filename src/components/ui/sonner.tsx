import { Toaster as Sonner, type ToasterProps } from "sonner";
import {
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
  Loader2Icon,
} from "lucide-react";

const Toaster = (props: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      position="bottom-center"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--te-bg)",
          "--normal-text": "var(--te-fg)",
          "--normal-border": "var(--te-gray)",
          "--border-radius": "0",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast border !rounded-none font-mono text-xs",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
