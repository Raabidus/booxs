import { useEffect, useRef, useState } from "react";
import { Camera, CameraOff, ScanLine } from "lucide-react";
import { normalizeIsbn } from "../shared/books";

export default function Scanner({
  onDetected,
}: {
  onDetected: (isbn: string) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const stop = useRef<() => void>(() => {});
  const generation = useRef(0);
  const onDetectedRef = useRef(onDetected);
  onDetectedRef.current = onDetected;

  const stopCamera = () => {
    generation.current++;
    stop.current();
    const stream = video.current?.srcObject as MediaStream | null;
    stream?.getTracks().forEach((track) => track.stop());
    if (video.current) video.current.srcObject = null;
    setRunning(false);
  };

  useEffect(() => {
    const hide = () => {
      if (document.hidden) stopCamera();
    };
    document.addEventListener("visibilitychange", hide);
    return () => {
      document.removeEventListener("visibilitychange", hide);
      stopCamera();
    };
  }, []);

  async function start() {
    stopCamera();
    const token = generation.current;
    setError("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setError(
        "Camera access needs HTTPS and a supported browser. Enter an ISBN below instead.",
      );
      return;
    }
    setRunning(true);
    try {
      const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] =
        await Promise.all([import("@zxing/browser"), import("@zxing/library")]);
      if (token !== generation.current) return;
      const hints = new Map();
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13]);
      hints.set(DecodeHintType.TRY_HARDER, true);
      const reader = new BrowserMultiFormatReader(hints, {
        delayBetweenScanAttempts: 150,
        delayBetweenScanSuccess: 1000,
      });
      const controls = await reader.decodeFromConstraints(
        {
          audio: false,
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        },
        video.current!,
        (result, _error, controls) => {
          if (!result || token !== generation.current) return;
          try {
            const isbn = normalizeIsbn(result.getText());
            controls.stop();
            stopCamera();
            onDetectedRef.current(isbn);
          } catch {
            /* Ignore non-book EANs and keep scanning. */
          }
        },
      );
      if (token !== generation.current) {
        controls.stop();
        return;
      }
      stop.current = () => controls.stop();
    } catch (error) {
      if (token !== generation.current) return;
      stopCamera();
      setError(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "Camera permission was denied. Allow the camera in Safari settings, or enter an ISBN below."
          : "The camera could not be started. Try again, or enter an ISBN below.",
      );
    }
  }

  return (
    <>
      <div className={"camera-window " + (running ? "is-running" : "")}>
        <video
          ref={video}
          muted
          playsInline
          autoPlay
          aria-label="Rear camera barcode preview"
        />
        {running ? (
          <>
            <div className="scan-reticle">
              <span />
              <span />
              <span />
              <span />
            </div>
            <p className="camera-caption">
              Hold the book’s barcode inside the frame
            </p>
          </>
        ) : (
          <div className="camera-placeholder">
            <ScanLine size={48} strokeWidth={1.2} />
            <p>
              A quick check before
              <br />
              your next chapter.
            </p>
            <button className="button lime" onClick={start}>
              <Camera size={18} />
              Start camera
            </button>
          </div>
        )}
      </div>
      {running && (
        <button className="text-button stop-camera" onClick={stopCamera}>
          <CameraOff size={16} />
          Stop camera
        </button>
      )}
      {error && (
        <p className="message error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
