import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useState } from "react";

import { environmentThreadShells } from "~/state/threads";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import type { RestartingMachine } from "./updateEverything.logic";

/** A thread an agent is working on now. A restart stops these; queued threads wait. */
const isRunning = (status: string) =>
  status === "preparing" || status === "starting" || status === "running";

/** Running threads across the environments in a newline-joined key. */
const runningThreadCountAtom = Atom.family((environmentIds: string) =>
  Atom.make((get) =>
    environmentIds
      .split("\n")
      .filter((id) => id !== "")
      .reduce(
        (count, id) =>
          count +
          get(environmentThreadShells.environmentThreadsAtom(EnvironmentId.make(id))).filter(
            (thread) => isRunning(thread.status),
          ).length,
        0,
      ),
  ).pipe(Atom.withLabel(`update-everything-running-threads:${environmentIds}`)),
);

interface UpdateEverythingDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly summary: string;
  readonly lines: ReadonlyArray<string>;
  readonly restarts: ReadonlyArray<RestartingMachine>;
  /** Gets the "Continue threads after restarts" choice, or undefined when
      the dialog did not offer it. */
  readonly onConfirm: (continueThreads: boolean | undefined) => void;
}

/**
 * Confirms an "update everything" run. It counts the running threads that the
 * restarts stop, and offers "Continue threads after restarts" for the
 * restarting servers.
 */
export function UpdateEverythingDialog({
  open,
  onOpenChange,
  ...content
}: UpdateEverythingDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        {/* The popup unmounts when closed, so the thread count is read only while open. */}
        <UpdateEverythingDialogContent {...content} />
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function UpdateEverythingDialogContent({
  summary,
  lines,
  restarts,
  onConfirm,
}: Omit<UpdateEverythingDialogProps, "open" | "onOpenChange">) {
  const runningThreads = useAtomValue(
    runningThreadCountAtom(restarts.map((machine) => machine.environmentId).join("\n")),
  );
  const [continueThreads, setContinueThreads] = useState(() =>
    restarts.every((machine) => machine.continueEnabled),
  );
  const offersContinue =
    runningThreads > 0 && restarts.every((machine) => machine.continueSupported);

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>{summary}?</AlertDialogTitle>
        <AlertDialogDescription className="whitespace-pre-line">
          {lines.join("\n")}
        </AlertDialogDescription>
        {runningThreads > 0 ? (
          <div className="flex flex-col gap-2 pt-2 text-sm">
            <p>
              {runningThreads} running {runningThreads === 1 ? "thread" : "threads"} will be
              interrupted.
            </p>
            {offersContinue ? (
              <label className="flex cursor-pointer items-center gap-2 text-muted-foreground">
                <Checkbox
                  checked={continueThreads}
                  onCheckedChange={(checked) => setContinueThreads(checked === true)}
                />
                Continue threads after restarts
              </label>
            ) : null}
          </div>
        ) : null}
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
        <Button onClick={() => onConfirm(offersContinue ? continueThreads : undefined)}>
          Update
        </Button>
      </AlertDialogFooter>
    </>
  );
}
