import { t, allowedAlignments } from "../config.mjs";
import { hasRulesPage } from "../data/rules-source.mjs";
import { generateName, nameStyleOptions } from "../data/name-generator.mjs";
import { yieldTakeoverTo } from "../app/takeover.mjs";

/**
 * The Details step: the character's name (the only mandatory field) plus the
 * optional identity/biography fields, the portrait, and the prototype-token
 * visuals (token image, dynamic ring, lock rotation).
 *
 * Text fields write straight through to {@link CreatorState#details} via the
 * shell's `data-step-change` channel; the image and toggle controls are click
 * actions. Nothing here touches the actor — the assembler reads this state on build.
 */

// The biography fields are defined here as plain lists so the template can loop over them and the
// handler can validate a changed field against them, instead of hard-coding 15 near-identical inputs.

/**
 * The short single-line fields, in display order.
 *
 * Alignment is deliberately absent: it is the one biography field the GM can constrain (see the
 * `bannedAlignments` house rule), which a plain text input cannot express, so it gets its own
 * list-plus-"Other" control ahead of this grid rather than being one more identical box.
 */
export const DETAIL_FIELDS = [
  "faith", "gender", "eyes", "hair", "skin", "height", "weight", "age"
];

/** The select's value for "none chosen yet" and for the free-text escape hatch. */
const ALIGNMENT_NONE = "";
const ALIGNMENT_OTHER = "__other__";
/** The multi-line fields, in display order. */
export const DETAIL_TEXT_FIELDS = ["trait", "ideals", "bonds", "flaws", "appearance", "biography"];
/** Multi-line fields that span the full form width (with their textarea row counts). */
const WIDE_TEXT_FIELDS = { appearance: 4, biography: 6 };

const FALLBACK_IMG = "icons/svg/mystery-man.svg";

/**
 * The alignment control's context: the offered list, which entry is showing, and the free-text box.
 *
 * dnd5e models `system.details.alignment` as a plain `StringField` and the character sheet renders
 * it verbatim, so what gets stored is the **label** a player picked ("Lawful Good"), never the
 * `CONFIG.DND5E.alignments` key — writing the key would show them "lg" on their own sheet.
 *
 * A value that matches nothing on offer still has to survive: it may be genuine homebrew, an
 * alignment arriving through the Ember hand-off, or one the GM banned after this character started.
 * Any of those select "Other" with the text intact rather than being silently blanked — losing what
 * a player typed is a far worse failure than showing an alignment the house rules no longer allow.
 * @param {CreatorState} state
 */
function alignmentContext(state) {
  const current = state.details.alignment ?? "";
  const options = allowedAlignments();
  const known = options.some(o => o.label === current);
  const other = state.alignmentOther || (!!current && !known);
  return {
    isOther: other,
    otherValue: other ? current : "",
    otherKey: ALIGNMENT_OTHER,
    options: [
      { value: ALIGNMENT_NONE, label: t("step.details.alignmentNone"), selected: !other && !current },
      ...options.map(o => ({ value: o.label, label: o.label, selected: !other && (o.label === current) })),
      { value: ALIGNMENT_OTHER, label: t("step.details.alignmentOther"), selected: other }
    ]
  };
}

export const detailsStep = {
  id: "details",
  icon: "fa-solid fa-address-card",
  labelKey: "step.details.label",
  template: "steps/details",

  // A name is the one thing the character cannot be built without.
  isComplete(state) {
    return !!state.details.name?.trim();
  },

  /** Why Next is blocked: no name entered yet. */
  incompleteHint(state) {
    return state.details.name?.trim() ? null : t("step.details.hint");
  },

  /** Rail summary: the chosen name (or nothing yet). */
  summary(state) {
    return state.details.name?.trim() ?? "";
  },

  async handle(action, el, { state, source, app }) {
    switch ( action ) {
      // A text input / textarea changed — `data-detail` names the field.
      case "detail": {
        const field = el.dataset.detail;
        if ( field && (field in state.details) ) state.details[field] = el.value;
        return;
      }
      // The alignment list. Picking "Other" clears the stored value and re-renders to reveal the
      // free-text box (which then writes through the plain `detail` case above like any other
      // field); picking a real alignment stores its label and puts the list back.
      case "alignment": {
        const picked = el.value;
        state.alignmentOther = picked === ALIGNMENT_OTHER;
        state.details.alignment = state.alignmentOther ? "" : picked;
        return;
      }
      // Toggle the random-name options popover (pool + style). These are an optional extra,
      // so they stay tucked away until the player opens them; close on an outside click or
      // Escape. Done purely in the DOM (no re-render) to avoid flickering the media images.
      case "nameOptions": {
        const pop = el.parentElement?.querySelector(".creator-name-pop");
        if ( !pop ) return false;
        const open = pop.classList.toggle("is-open");
        el.classList.toggle("is-active", open);
        el.setAttribute("aria-expanded", open ? "true" : "false");
        if ( open ) {
          const close = ev => {
            if ( ev.type === "keydown" && ev.key !== "Escape" ) return;
            if ( ev.type === "pointerdown" && (pop.contains(ev.target) || el.contains(ev.target)) ) return;
            pop.classList.remove("is-open");
            el.classList.remove("is-active");
            el.setAttribute("aria-expanded", "false");
            document.removeEventListener("pointerdown", close, true);
            document.removeEventListener("keydown", close, true);
          };
          document.addEventListener("pointerdown", close, true);
          document.addEventListener("keydown", close, true);
        }
        return false;
      }
      // Pick which name pool the roller draws from: "any" | "male" | "female". Reflect the
      // active option in place and skip the re-render, so the media images don't flicker.
      case "nameGender": {
        const choice = el.dataset.gender;
        if ( ["any", "male", "female"].includes(choice) ) {
          state.nameGender = choice;
          for ( const btn of el.parentElement?.querySelectorAll(".creator-name-gender-opt") ?? [] ) {
            btn.classList.toggle("is-active", btn === el);
          }
        }
        return false;
      }
      // Choose which naming style the roller uses: "auto" (follow the species) or a style key.
      // The native <select> already reflects the value, so no re-render is needed.
      case "nameStyle": {
        state.nameStyle = el.value || "auto";
        return false;
      }
      // Roll a random name. Write the result straight to the field (and enable Next) instead of
      // re-rendering, which would rebuild and flicker the portrait/token images on the left.
      case "generateName": {
        // "auto" follows the chosen species; an explicit style key overrides it.
        const speciesId = source?.card(state.speciesUuid)?.identifier;
        const style = (state.nameStyle && state.nameStyle !== "auto") ? state.nameStyle : speciesId;
        // "any" passes no gender, so the generator draws from both pools at random.
        const gender = state.nameGender === "any" ? "" : state.nameGender;
        state.details.name = generateName(style, { gender });
        const root = app?.element;
        const input = root?.querySelector("#creator-cc-name");
        if ( input ) input.value = state.details.name;
        // A non-empty name completes this step; reflect that on the Next button in place.
        const next = root?.querySelector("button[data-action='navNext']");
        if ( next ) next.disabled = false;
        return false;
      }
      case "portrait": return pickImage(state, app, "portrait");
      case "tokenImg": return pickImage(state, app, "tokenImg");
      case "tokenRingImg": return pickImage(state, app, "tokenRingImg");
      case "tokenTab": state.tokenTab = el.dataset.tab === "ring" ? "ring" : "token"; return;
      case "toggleRing": state.tokenRingEnabled = !state.tokenRingEnabled; return;
      case "toggleLock": state.tokenLockRotation = !state.tokenLockRotation; return;
    }
  },

  async context({ state, source }) {
    const d = state.details;
    const field = key => ({
      key,
      value: d[key] ?? "",
      label: t(`step.details.field.${key}`),
      placeholder: t(`step.details.placeholder.${key}`)
    });
    const gridTextKeys = DETAIL_TEXT_FIELDS.filter(k => !(k in WIDE_TEXT_FIELDS));
    const onRing = state.tokenTab === "ring";
    return {
      name: d.name ?? "",
      namePlaceholder: t("step.details.namePlaceholder"),
      subtitle: t("step.details.subtitle"),
      // Random-name pool selector: the active option drives the dice roll.
      nameGenders: ["any", "male", "female"].map(key => ({
        key,
        label: t(`step.details.nameGender.${key}`),
        active: state.nameGender === key
      })),
      // Naming-style selector: an "auto" option (follow the chosen species) plus every style.
      nameStyles: (() => {
        const speciesName = source?.card(state.speciesUuid)?.name;
        const auto = {
          key: "auto",
          label: speciesName
            ? t("step.details.nameStyle.auto", { species: speciesName })
            : t("step.details.nameStyle.autoNone"),
          selected: state.nameStyle === "auto"
        };
        const rest = nameStyleOptions().map(o => ({ ...o, selected: state.nameStyle === o.key }));
        return [auto, ...rest];
      })(),
      alignment: alignmentContext(state),
      // Alignment is the only part of this step the rulebook really speaks to, so that is what the
      // control opens. Null when the world has no book covering it, so it is hidden rather than dead.
      rulesTopic: (await hasRulesPage("alignment", source.rulesOf(state.classUuid))) ? "alignment" : null,
      rulesEdition: source.rulesOf(state.classUuid) ?? null,
      shortFields: DETAIL_FIELDS.map(field),
      gridTextFields: gridTextKeys.map(k => ({ ...field(k), rows: 3 })),
      wideTextFields: Object.entries(WIDE_TEXT_FIELDS).map(([k, rows]) => ({ ...field(k), rows })),
      portrait: state.portrait || FALLBACK_IMG,
      // The token column shows one image at a time; the tab picks token vs ring subject.
      onRing,
      onToken: !onRing,
      tokenImg: (onRing ? state.tokenRingImg : state.tokenImg) || FALLBACK_IMG,
      ringEnabled: state.tokenRingEnabled,
      lockRotation: state.tokenLockRotation
    };
  }
};

/* -------------------------------------------- */

/** Which state property each image control writes. */
const IMAGE_TARGET = { portrait: "portrait", tokenImg: "tokenImg", tokenRingImg: "tokenRingImg" };

/**
 * Open Foundry's image FilePicker for one of the three image slots, writing the
 * chosen path back to state and re-rendering when the user confirms. The picker
 * resolves after this handler returns, so it asks the shell to render itself.
 */
async function pickImage(state, app, slot) {
  const prop = IMAGE_TARGET[slot];
  // FilePicker moved namespace across Foundry versions; try the modern location, fall back to the
  // old global so the module keeps working on both.
  const Picker = foundry.applications.apps.FilePicker?.implementation ?? FilePicker;
  const picker = new Picker({
    type: "image",
    current: state[prop],
    callback: path => { state[prop] = path; app?.render(); }
  });
  yieldTakeoverTo(picker);
  await picker.render(true);
  return picker;
}

/* `yieldTakeoverTo` used to live here, written for these three image buttons. It is shared now —
   see app/takeover.mjs — because the same trap catches every window opened from inside the
   takeover, including the item sheets the Review screen's content links open. Note it is called
   above *before* the picker renders: the shared version marks an application it cannot mark the
   element of yet, and finishes the job on the render hook. */
