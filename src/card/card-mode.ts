//The card's mutually-exclusive view modes. One single state replaces the historical pair of
//_lidarViewMode / _weatherMode booleans, so the mode-bar click handler can't leave the card in
//an inconsistent intermediate state (one flag flipping before the other and the chip / slider /
//timeline transitions drifting out of sync as a result).
//
//- 'base': the default HUD with chips, leaders, arcs and timeline.
//- 'lidar': the WebGL dot-cloud overlay + the bottom opacity slider.
//- 'weather': the top-down meteorological overlay (zoomed-out camera + per-altitude cloud-cover
//             raster painted from the multi-point Open-Meteo grid).
//
//Transitions between any two modes are driven by a state machine in HeliosCard.updated() which kicks
//the WebGL / overlay fade-in / fade-out loops and toggles the overlay mask. CSS animations are pure
//class-driven transitions on the elements themselves, so a class change driven by _cardMode in one
//render is sufficient to animate the slide-in or slide-out reliably.

export type CardMode = 'base' | 'lidar' | 'weather';
