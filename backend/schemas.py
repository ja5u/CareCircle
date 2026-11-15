import re
from datetime import date, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, Field, field_validator, model_validator


class Credentials(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    passcode: str = Field(min_length=8, max_length=64)

    @field_validator("email")
    @classmethod
    def valid_email(cls, value):
        value = value.strip().lower()
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value):
            raise ValueError("Enter a valid email address.")
        return value


class Register(Credentials):
    name: str = Field(min_length=1, max_length=80)
    timezone: str = "Asia/Kolkata"

    @field_validator("timezone")
    @classmethod
    def valid_timezone(cls, value):
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError("Choose a valid IANA time zone.")
        return value


class Invite(BaseModel):
    role: str = Field(pattern="^(editor|viewer)$")


class Join(BaseModel):
    code: str = Field(min_length=10, max_length=128)


class MemberChange(BaseModel):
    role: str = Field(pattern="^(editor|viewer)$")
    active: bool = True


class Preferences(BaseModel):
    email_enabled: bool = True
    sharing_enabled: bool = False
    contact_id: int | None = None
    upcoming_minutes: int = Field(default=15, ge=1, le=120)
    grace_minutes: int = Field(default=30, ge=5, le=240)
    followup_minutes: int = Field(default=60, ge=5, le=480)
    appointment_hours: int = Field(default=24, ge=1, le=168)

    @model_validator(mode="after")
    def valid_followup(self):
        if self.followup_minutes < self.grace_minutes:
            raise ValueError("Follow-up time must be at or after the unconfirmed-dose reminder.")
        if self.sharing_enabled and self.contact_id is None:
            raise ValueError("Select a contact before enabling check-ins.")
        return self


class MedicationInput(BaseModel):
    revision: int | None = Field(default=None, ge=1)
    name: str = Field(min_length=1, max_length=120)
    dose: str = Field(min_length=1, max_length=120)
    instructions: str = Field(default="", max_length=1000)
    times: list[str] = Field(min_length=1, max_length=12)
    start_date: date
    end_date: date | None = None
    active: bool = True

    @field_validator("name", "dose")
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError("This field is required.")
        return value.strip()

    @field_validator("times")
    @classmethod
    def valid_times(cls, values):
        if any(not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", v) for v in values):
            raise ValueError("Use 24-hour times such as 08:00 and 20:00.")
        return sorted(set(values))

    @model_validator(mode="after")
    def valid_dates(self):
        if self.end_date and self.end_date < self.start_date:
            raise ValueError("End date must be on or after the start date.")
        return self


class DoseUpdate(BaseModel):
    status: str = Field(pattern="^(taken|skipped|pending)$")
    version: int = Field(ge=1)
    note: str = Field(default="", max_length=500)


class AppointmentInput(BaseModel):
    revision: int | None = Field(default=None, ge=1)
    doctor: str = Field(min_length=1, max_length=120)
    location: str = Field(default="", max_length=250)
    notes: str = Field(default="", max_length=1000)
    scheduled_at: datetime
    cancelled: bool = False

    @field_validator("scheduled_at")
    @classmethod
    def aware_time(cls, value):
        if value.tzinfo is None:
            raise ValueError("Appointment time must include a time zone offset.")
        return value


class CheckIn(BaseModel):
    message: str = Field(default="Please check in with me.", min_length=1, max_length=500)


class Outcome(BaseModel):
    outcome: str = Field(min_length=1, max_length=500)


class AssistantInput(BaseModel):
    text: str = Field(min_length=1, max_length=1500)


class AssistantIntent(BaseModel):
    intent: str = Field(pattern="^(today|next|appointment|taken|help|cancel|unknown)$")
    medication: str = Field(default="", max_length=120)
    time: str = Field(default="", max_length=5)


class SpeechInput(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
