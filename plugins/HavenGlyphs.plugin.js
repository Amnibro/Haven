/**
 * @name Haven Glyphs
 * @description Selects the Glyphs icon pack. The glyphs are built into Haven now (Settings > Appearance > Icons); this plugin stays so installs that enabled it keep their icons.
 * @author bernardokcosta
 * @version 2.0.0
 */
// Haven Glyphs first drew the interface's icons with Font Awesome Solid. Its
// sweep became Haven's icon packs (public/js/icon-packs.js), Glyphs among
// them, so the plugin no longer draws anything itself: enabling it picks
// the Glyphs pack, and disabling it while Glyphs is picked goes back to
// emoji, which is what turning the old plugin off looked like.
class HavenGlyphs {
  static icons() {
    return (typeof window !== 'undefined' && window.HavenIcons) || null;
  }

  start() {
    const icons = HavenGlyphs.icons();
    if (icons && icons.saved() !== 'glyphs') icons.choose('glyphs');
  }

  stop() {
    const icons = HavenGlyphs.icons();
    if (icons && icons.saved() === 'glyphs') icons.choose('emoji');
  }
}

if (typeof module !== 'undefined') module.exports = HavenGlyphs;
if (typeof _win !== 'undefined') _win.HavenGlyphs = HavenGlyphs;
