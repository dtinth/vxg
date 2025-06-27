import { GoogleGenerativeAI } from "@google/generative-ai";
import { useStore } from "@nanostores/react";
import { Action, ActionPanel, getPreferenceValues, Icon, List } from "@raycast/api";
import { atom } from "nanostores";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { useEffect, useState } from "react";
import { uuidv7 } from "uuidv7";

function transcribe(buffer: Buffer) {
  const { gemini_api_key } = getPreferenceValues<{ gemini_api_key: string }>();
  const genAI = new GoogleGenerativeAI(gemini_api_key);
  const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash",
  });
  return model.generateContentStream([
    {
      inlineData: {
        mimeType: "audio/mp3",
        data: buffer.toString("base64"),
      },
    },
    {
      text: 'Please transcribe any speech in this audio. If there is no clear speech, respond with "No speech detected".',
    },
  ]);
}

class RecordingController {
  latestItemId: string | undefined;
  $selectedItem = atom<string | undefined>("record");
  $currentRecording = atom<Recording | null>(null);
  $stoppedRecordings = atom<Recording[]>([]);
  startRecording() {
    console.log("Recording started");
    const recording = new Recording({
      onStopped: () => {
        if (this.$currentRecording.get() === recording) {
          this.latestItemId = recording.id;
          this.$currentRecording.set(null);
          this.$stoppedRecordings.set([recording, ...this.$stoppedRecordings.get()]);
        }
      },
    });
    this.$currentRecording.set(recording);
  }
  deleteRecording(recording: Recording) {
    const updated = this.$stoppedRecordings.get().filter((r) => r.id !== recording.id);
    this.$stoppedRecordings.set(updated);
    if (this.$selectedItem.get() === recording.id) {
      this.$selectedItem.set("record");
    }
  }
}

interface TranscriptionState {
  finished: boolean;
  transcription: string;
  error: string | null;
}

class Recording {
  id = uuidv7();
  createdAt = Date.now();
  $duration = atom(0);
  $transcription = atom<TranscriptionState | null>(null);
  $status = atom<"recording" | "stopping" | "stopped">("recording");
  recorder: AudioRecorder;
  private abortController: AbortController;
  constructor(private options: { onStopped: () => void }) {
    this.abortController = new AbortController();
    this.recorder = new AudioRecorder(this.id, this.abortController.signal);
    this.recorder.finishPromise.then(() => {
      this.$status.set("stopped");
      this.options.onStopped();
      mkdirSync(dirname(this.mp3Path), { recursive: true });
      writeFileSync(this.mp3Path, this.recorder.getBuffer());
      this.transcribe();
    });
  }
  get mp3Path() {
    return `/tmp/vxg/${this.id}.mp3`;
  }
  get txtPath() {
    return `/tmp/vxg/${this.id}.txt`;
  }
  stop() {
    if (this.$status.get() !== "recording") {
      return;
    }
    this.$status.set("stopping");
    this.abortController.abort();
  }
  async transcribe() {
    if (this.$transcription.get() && !this.$transcription.get()!.finished) {
      return;
    }
    const buffer = this.recorder.getBuffer();
    this.$transcription.set({
      finished: false,
      transcription: "",
      error: null,
    });
    let transcription = "";
    try {
      const stream = await transcribe(buffer);
      for await (const chunk of stream.stream) {
        transcription += chunk.text();
        this.$transcription.set({
          finished: false,
          transcription,
          error: null,
        });
      }
      this.$transcription.set({
        finished: true,
        transcription,
        error: null,
      });
      // Write transcription to .txt file
      writeFileSync(this.txtPath, transcription, "utf8");
    } catch (error: unknown) {
      this.$transcription.set({
        finished: true,
        transcription,
        error: String(error),
      });
      console.error("Error during transcription:", error);
      return;
    }
  }
}

class AudioRecorder {
  $levels = atom("[      |      ]");
  $duration = atom("00:00:00.00");
  finishPromise: Promise<void>;
  buffers: Buffer[] = [];
  constructor(
    private id: string,
    abortSignal: AbortSignal,
  ) {
    const child = spawn(
      `/opt/homebrew/bin/sox -c 1 -t coreaudio "MacBook Pro Microphone" -t mp3 -C 128 --buffer 256 -`,
      { shell: true },
    );
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (c) => {
      const levelMatch = c.match(/\[[-= |]+\]/);
      if (levelMatch) {
        this.$levels.set(levelMatch[0]);
      }

      const durationMatch = c.match(/\d\d:\d\d:\d\d\.\d\d/);
      if (durationMatch) {
        this.$duration.set(durationMatch[0]);
      }
    });
    child.stdout.on("data", (c) => {
      this.buffers.push(c);
    });
    abortSignal.addEventListener("abort", () => {
      child.kill("SIGINT");
    });
    this.finishPromise = new Promise((resolve) => {
      child.on("close", () => {
        resolve();
      });
    });
  }
  getBuffer() {
    return Buffer.concat(this.buffers);
  }
}

export default function Command() {
  const [controller] = useState(() => new RecordingController());
  const selectedItem = useStore(controller.$selectedItem);
  const currentRecording = useStore(controller.$currentRecording);
  const stoppedRecordings = useStore(controller.$stoppedRecordings);
  const isRecording = !!currentRecording;
  useEffect(() => {
    const latestItemId = controller.latestItemId;
    if (latestItemId && stoppedRecordings.some((recording) => recording.id === latestItemId)) {
      controller.latestItemId = undefined;
      setTimeout(() => {
        controller.$selectedItem.set(latestItemId);
      }, 100);
    }
  }, [stoppedRecordings]);
  return (
    <List
      isShowingDetail
      selectedItemId={selectedItem || "record"}
      onSelectionChange={(id) => {
        controller.$selectedItem.set(id || "record");
      }}
    >
      <List.Item
        id={"record"}
        title={isRecording ? "Now recording…" : "Start recording"}
        icon={isRecording ? Icon.Stop : Icon.CircleFilled}
        actions={
          <ActionPanel>
            <Action
              title={isRecording ? "Stop Recording" : "Start Recording"}
              icon={isRecording ? Icon.Stop : Icon.CircleFilled}
              onAction={isRecording ? () => currentRecording.stop() : () => controller.startRecording()}
            />
          </ActionPanel>
        }
        detail={isRecording ? <CurrentRecordingDetail currentRecording={currentRecording} /> : null}
      />
      {stoppedRecordings.map((recording) => (
        <StoppedRecordingItem
          key={recording.id}
          recording={recording}
          onDelete={() => controller.deleteRecording(recording)}
        />
      ))}
    </List>
  );
}

const CurrentRecordingDetail: React.FC<{ currentRecording: Recording }> = ({ currentRecording }) => {
  const status = useStore(currentRecording.$status);
  const duration = useStore(currentRecording.recorder.$duration);
  const levels = useStore(currentRecording.recorder.$levels);
  return (
    <List.Item.Detail
      markdown={`# ${status}`}
      metadata={
        <List.Item.Detail.Metadata>
          <List.Item.Detail.Metadata.Label title="Duration" text={duration} />
          <List.Item.Detail.Metadata.Label title="Sound Level" text={levels} />
        </List.Item.Detail.Metadata>
      }
    />
  );
};

const StoppedRecordingItem: React.FC<{ recording: Recording; onDelete: () => void }> = ({ recording, onDelete }) => {
  const transcription = useStore(recording.$transcription);
  const getTranscriptionMarkdown = (transcription: TranscriptionState) => {
    let text = transcription.transcription;
    if (!transcription.finished) {
      text += "...";
    }
    if (transcription.error) {
      text += `\n\nError: ${transcription.error}`;
    }
    return text;
  };

  const textToCopy = String(transcription?.transcription || "No transcription").trim();
  return (
    <List.Item
      id={recording.id}
      title={formatTime(recording.createdAt)}
      subtitle={transcription?.transcription || ""}
      icon={Icon.Microphone}
      detail={
        <List.Item.Detail
          isLoading={!transcription?.finished}
          markdown={transcription ? getTranscriptionMarkdown(transcription) : `No transcription`}
        />
      }
      actions={
        <ActionPanel>
          <Action.Paste title="Type" content={textToCopy} />
          <Action.Paste
            title="Type (Decapitalized)"
            content={textToCopy.charAt(0).toLowerCase() + textToCopy.slice(1)}
            shortcut={{ modifiers: ["shift"], key: "return" }}
          />
          <Action.CopyToClipboard title="Copy" content={textToCopy} shortcut={{ modifiers: ["opt"], key: "return" }} />
          <Action.CopyToClipboard
            title="Copy (Decapitalized)"
            content={textToCopy.charAt(0).toLowerCase() + textToCopy.slice(1)}
            shortcut={{ modifiers: ["opt", "shift"], key: "return" }}
          />
          <Action
            title="Retry"
            icon={Icon.Repeat}
            onAction={() => {
              recording.transcribe();
            }}
            shortcut={{ modifiers: ["cmd"], key: "r" }}
          />
          <Action
            title="Delete"
            icon={Icon.Trash}
            onAction={onDelete}
            shortcut={{ modifiers: ["cmd"], key: "backspace" }}
          />
          <Action.ShowInFinder
            title="Show in Finder"
            path={recording.mp3Path}
            shortcut={{ modifiers: ["cmd"], key: "return" }}
          />
        </ActionPanel>
      }
    />
  );
};

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}
