//The card's mutually-exclusive view modes. One single state replaces the historical pair of
//_lidarViewMode / _shadingDomeMode booleans, so the mode-bar click handler can't leave the card in
//an inconsistent intermediate state (one flag flipping before the other and the chip / slider /
//timeline transitions drifting out of sync as a result).
//
//- 'base': the default HUD with chips, leaders, arcs and timeline.
//- 'lidar': the WebGL dot-cloud overlay + the bottom opacity slider.
//- 'shading-dome': the SVG hemisphere overlay + the bottom cloud-cover slider + the explanation hint.
//
//Transitions between any two modes are driven by a state machine in HeliosCard.updated() which kicks
//the WebGL / SVG fade-in / fade-out loops and toggles the overlay mask. CSS animations are pure
//class-driven transitions on the elements themselves, so a class change driven by _cardMode in one
//render is sufficient to animate the slide-in or slide-out reliably.

export type CardMode = 'base' | 'lidar' | 'shading-dome';
