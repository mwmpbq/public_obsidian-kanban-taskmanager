import { describe, expect, it } from 'vitest';
import { type DoneCandidate, type DoneElement, guardMove, planDone, planDoneMove } from './done';

const TODAY = '2026-09-09';
const ROOT = '02_Projects/Nimbus/Deliverables';
const ATOMIC = '_Tasks/Atomic';

function nested(over: Partial<DoneCandidate>): DoneCandidate {
  const folder = `${ROOT}/featureXY/Task1`;
  return {
    form: 'nested',
    folderPath: folder,
    notePath: `${folder}/_Task1.md`,
    base: ROOT,
    done: false,
    ...over,
  };
}

describe('planDoneMove nested', () => {
  it('moves an open folder into the Done mirror and stamps completed', () => {
    const plan = planDoneMove(nested({ done: true }), TODAY);
    expect(plan).toEqual({
      from: `${ROOT}/featureXY/Task1`,
      to: `${ROOT}/Done/featureXY/Task1`,
      toNotePath: `${ROOT}/Done/featureXY/Task1/_Task1.md`,
      parent: `${ROOT}/Done/featureXY`,
      frontmatter: { completed: TODAY },
    });
  });

  it('keeps completed as is when it already exists', () => {
    const plan = planDoneMove(nested({ done: true, completed: '2026-09-01' }), TODAY);
    expect(plan?.frontmatter).toBeNull();
  });

  it('brings a mirrored folder back and clears completed on reopen', () => {
    const folder = `${ROOT}/Done/featureXY/Task1`;
    const plan = planDoneMove(
      nested({ folderPath: folder, notePath: `${folder}/_Task1.md`, done: false, completed: '2026-09-05' }),
      TODAY,
    );
    expect(plan).toEqual({
      from: `${ROOT}/Done/featureXY/Task1`,
      to: `${ROOT}/featureXY/Task1`,
      toNotePath: `${ROOT}/featureXY/Task1/_Task1.md`,
      parent: `${ROOT}/featureXY`,
      frontmatter: { completed: null },
    });
  });

  it('does nothing when an open task already sits outside Done', () => {
    expect(planDoneMove(nested({ done: false }), TODAY)).toBeNull();
  });

  it('does nothing when a done task already sits inside Done', () => {
    const folder = `${ROOT}/Done/featureXY/Task1`;
    const plan = planDoneMove(
      nested({ folderPath: folder, notePath: `${folder}/_Task1.md`, done: true }),
      TODAY,
    );
    expect(plan).toBeNull();
  });
});

describe('planDoneMove atomic', () => {
  const note = `${ATOMIC}/2026-09-04_angebot-workshop.md`;

  it('moves the note into Atomic/Done', () => {
    const plan = planDoneMove(
      { form: 'atomic', notePath: note, base: ATOMIC, done: true },
      TODAY,
    );
    expect(plan).toEqual({
      from: note,
      to: `${ATOMIC}/Done/2026-09-04_angebot-workshop.md`,
      toNotePath: `${ATOMIC}/Done/2026-09-04_angebot-workshop.md`,
      parent: `${ATOMIC}/Done`,
      frontmatter: { completed: TODAY },
    });
  });

  it('reopens a note from Atomic/Done', () => {
    const done = `${ATOMIC}/Done/2026-09-04_angebot-workshop.md`;
    const plan = planDoneMove(
      { form: 'atomic', notePath: done, base: ATOMIC, done: false, completed: '2026-09-02' },
      TODAY,
    );
    expect(plan?.to).toBe(note);
    expect(plan?.frontmatter).toEqual({ completed: null });
  });
});

// The nimbus fixture hierarchy: epic pb > feature da > tasks. staging is already
// mirrored under Done, pipeline is the second task. Callers toggle done/location.
const PB_NOTE = `${ROOT}/2026-05-04_pb/_2026-05-04_pb.md`;
const DA_FOLDER = `${ROOT}/2026-05-04_pb/2026-08-11_da`;
const DA_NOTE = `${DA_FOLDER}/_2026-08-11_da.md`;
const DA_DONE_FOLDER = `${ROOT}/Done/2026-05-04_pb/2026-08-11_da`;
const DA_DONE_NOTE = `${DA_DONE_FOLDER}/_2026-08-11_da.md`;
const PIPE_FOLDER = `${DA_FOLDER}/2026-09-01_pipeline`;
const PIPE_DONE_FOLDER = `${DA_DONE_FOLDER}/2026-09-01_pipeline`;
const STAGING_DONE_FOLDER = `${DA_DONE_FOLDER}/2026-08-28_staging`;

function epicPb(): DoneElement {
  return {
    form: 'nested',
    type: 'epic',
    title: 'Plattform-Betrieb',
    notePath: PB_NOTE,
    folderPath: `${ROOT}/2026-05-04_pb`,
    base: ROOT,
    done: false,
  };
}

function featureDa(over: Partial<DoneElement> = {}): DoneElement {
  return {
    form: 'nested',
    type: 'feature',
    title: 'Datenaufnahme stabilisieren',
    notePath: DA_NOTE,
    folderPath: DA_FOLDER,
    base: ROOT,
    done: false,
    parentNote: PB_NOTE,
    ...over,
  };
}

function staging(over: Partial<DoneElement> = {}): DoneElement {
  return {
    form: 'nested',
    type: 'task',
    title: 'Zugriff auf Staging-Datenbank einrichten',
    notePath: `${STAGING_DONE_FOLDER}/_2026-08-28_staging.md`,
    folderPath: STAGING_DONE_FOLDER,
    base: ROOT,
    done: true,
    completed: '2026-09-05',
    parentNote: DA_NOTE,
    ...over,
  };
}

function pipeline(over: Partial<DoneElement> = {}): DoneElement {
  return {
    form: 'nested',
    type: 'task',
    title: 'Pipeline-Fehler bei leeren Dateien beheben',
    notePath: `${PIPE_FOLDER}/_2026-09-01_pipeline.md`,
    folderPath: PIPE_FOLDER,
    base: ROOT,
    done: false,
    parentNote: DA_NOTE,
    ...over,
  };
}

describe('planDone container migration', () => {
  it('K1: leaves an open feature in place though a child is already mirrored', () => {
    const plan = planDone([epicPb(), featureDa(), pipeline(), staging()], TODAY);
    expect(plan.moves).toEqual([]);
    expect(plan.notices).toEqual([]);
  });

  it('K2/K3: moves the done feature as one container and never re-moves the mirrored child', () => {
    const donePipe = pipeline({
      notePath: `${PIPE_DONE_FOLDER}/_2026-09-01_pipeline.md`,
      folderPath: PIPE_DONE_FOLDER,
      done: true,
      completed: TODAY,
    });
    const plan = planDone([epicPb(), featureDa({ done: true, completed: TODAY }), donePipe, staging()], TODAY);
    expect(plan.moves).toEqual([
      {
        from: DA_FOLDER,
        to: DA_DONE_FOLDER,
        toNotePath: DA_DONE_NOTE,
        parent: `${ROOT}/Done/2026-05-04_pb`,
        frontmatter: null,
      },
    ]);
    expect(plan.moves.some((m) => m.from === STAGING_DONE_FOLDER)).toBe(false);
  });

  it('drops a child move when its container moves in the same pass', () => {
    const plan = planDone(
      [
        epicPb(),
        featureDa({ done: true, completed: TODAY }),
        pipeline({ done: true }),
        staging(),
      ],
      TODAY,
    );
    expect(plan.moves).toHaveLength(1);
    expect(plan.moves[0].from).toBe(DA_FOLDER);
  });
});

describe('planDone locks', () => {
  it('K4/K6: a done feature with an open child does not move and names the child', () => {
    const plan = planDone([epicPb(), featureDa({ done: true }), pipeline(), staging()], TODAY);
    expect(plan.moves).toEqual([]);
    expect(plan.notices).toHaveLength(1);
    expect(plan.notices[0]).toContain('Pipeline-Fehler bei leeren Dateien beheben');
  });

  it('K5: an open child under a done, mirrored feature is not pulled back and names the feature', () => {
    const doneDa = featureDa({ notePath: DA_DONE_NOTE, folderPath: DA_DONE_FOLDER, done: true });
    const reopened = staging({ done: false, completed: undefined, parentNote: DA_DONE_NOTE });
    const plan = planDone([epicPb(), doneDa, reopened], TODAY);
    expect(plan.moves).toEqual([]);
    expect(plan.notices).toHaveLength(1);
    expect(plan.notices[0]).toContain('Datenaufnahme stabilisieren');
  });
});

describe('guardMove', () => {
  it('K4: blocks closing a feature while a task is open', () => {
    const notice = guardMove(featureDa(), true, [epicPb(), featureDa(), pipeline(), staging()]);
    expect(notice).toContain('Datenaufnahme stabilisieren');
    expect(notice).toContain('Pipeline-Fehler bei leeren Dateien beheben');
  });

  it('K5: blocks reopening a task while its feature is still done', () => {
    const doneDa = featureDa({ notePath: DA_DONE_NOTE, folderPath: DA_DONE_FOLDER, done: true });
    const child = staging({ parentNote: DA_DONE_NOTE });
    const notice = guardMove(child, false, [epicPb(), doneDa, child]);
    expect(notice).toContain('Datenaufnahme stabilisieren');
  });

  it('lets a task close when it has no open descendant', () => {
    expect(guardMove(pipeline(), true, [epicPb(), featureDa(), pipeline(), staging()])).toBeNull();
  });

  it('lets a task reopen when its feature is open', () => {
    const child = staging({ done: true });
    expect(guardMove(child, false, [epicPb(), featureDa(), child])).toBeNull();
  });
});
