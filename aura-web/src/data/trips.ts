/** Fares and hotels come from the live travel API; bookings here are user-approved records (AURA never books or charges). */
export interface FlightResult {
  id: string; airline: string; code: string; dep: string; arr: string; dur: string; price: number; currency: string; stops: string; link?: string;
}

export interface HotelResult { id: string; name: string; perNight?: number; total?: number; currency: string; stars?: string; rating?: number; link?: string }

/** A trip or booking the user saved. */
export interface Booking { id: string; title: string; detail: string; status: 'Saved' | 'Pending approval' | 'Confirmed'; link?: string }

export interface TripPlan { id: string; destination: string; from?: string; startDate: string; endDate: string; days: { day: string; items: string[] }[] }

/**
 * One interested/not-interested signal on a flight or hotel result,
 * snapshotted at the time the user reacted. AURA's ai-service retrains a
 * daily interest model from these to rank future travel suggestions.
 */
export interface TravelFeedback {
  id: string;
  itemId: string;
  interested: boolean;
  mode: 'flight' | 'hotel';
  title: string;
  price: number;
  currency: string;
  provider?: string;
  rating?: number;
  createdAt: string;
}
