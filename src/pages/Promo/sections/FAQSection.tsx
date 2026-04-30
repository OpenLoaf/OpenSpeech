import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

const FAQS: { question: string; answer: string }[] = [
  {
    question: "OpenSpeech 是免费的吗？",
    answer:
      "是。客户端开源免费，你只需自备一个 ASR 服务（OpenAI Whisper API、自部署 whisper、第三方实时 ASR 等都行）。",
  },
  {
    question: "支持哪些操作系统？",
    answer:
      "macOS（Apple Silicon + Intel）、Windows 10/11、Linux x86_64。三平台同一份 Tauri bundle。",
  },
  {
    question: "语音数据会被上传到 OpenSpeech 吗？",
    answer:
      "不会。音频帧只发送到你自己配置的 ASR endpoint。OpenSpeech 不存任何录音、不做日志埋点。",
  },
  {
    question: "支持哪些 ASR 模型？",
    answer:
      "任何 REST/Realtime ASR endpoint：OpenAI Whisper、Deepgram、火山引擎 ASR、阿里云 NLS、自部署 whisper.cpp、自部署 sherpa-onnx。",
  },
  {
    question: "怎么唤起？快捷键能改吗？",
    answer:
      "默认 macOS 是 Fn + Control，Windows 是 Ctrl + Win，Linux 是 Ctrl + Super，按一下开始、再按一下结束。在设置里可以改成任意全局快捷键组合、单键 PTT 或修饰键双击。",
  },
  {
    question: "转写错了能撤销吗？",
    answer:
      "可以。每次注入文字后会保留历史记录，最近 N 条可一键撤销/复制/重新转写。",
  },
];

export default function FAQSection() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <section
      id="faq"
      data-promo-section
      className="bg-te-bg px-[4vw] py-[clamp(4rem,10vw,8rem)]"
    >
      <div className="mx-auto max-w-3xl">
        <motion.div
          className="mb-12 md:mb-16"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
        >
          <div className="mb-3 font-mono text-xs uppercase tracking-[0.2em] text-te-light-gray/50">
            [03] FAQ
          </div>
          <h2 className="font-mono text-2xl font-bold tracking-tighter text-te-fg md:text-3xl">
            常见问题
          </h2>
        </motion.div>

        <div className="divide-y divide-te-gray/30">
          {FAQS.map((faq, index) => {
            const isOpen = openIndex === index;
            return (
              <motion.div
                key={faq.question}
                initial={{ opacity: 0, y: 12 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.4, delay: index * 0.05 }}
              >
                <button
                  type="button"
                  className="group flex w-full items-center justify-between gap-4 py-5 text-left"
                  onClick={() => setOpenIndex(isOpen ? null : index)}
                  aria-expanded={isOpen}
                >
                  <span className="font-mono text-sm font-bold tracking-tight text-te-fg/90 transition-colors group-hover:text-te-accent">
                    {faq.question}
                  </span>
                  <motion.span
                    className="ml-4 shrink-0 font-mono text-lg leading-none text-te-light-gray"
                    animate={{ rotate: isOpen ? 45 : 0 }}
                    transition={{ duration: 0.2 }}
                  >
                    +
                  </motion.span>
                </button>

                <AnimatePresence initial={false}>
                  {isOpen && (
                    <motion.div
                      key="content"
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.3 }}
                      className="overflow-hidden"
                    >
                      <p className="pb-5 pr-8 text-sm leading-relaxed text-te-light-gray/60">
                        {faq.answer}
                      </p>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
