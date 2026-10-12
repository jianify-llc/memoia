# Modified for Memoia: relocated from the upstream memobase_server package.
from ..env import CONFIG, LOG
from .profile_init_utils import (
    UserProfileTopic,
    formate_profile_topic,
    modify_default_user_profile,
)
from .user_profile_topics import default_profile_topics


CANDIDATE_PROFILE_TOPICS = modify_default_user_profile(default_profile_topics("zh"))


def get_prompt(profiles: list[UserProfileTopic] = CANDIDATE_PROFILE_TOPICS):
    return "\n".join([formate_profile_topic(up) for up in profiles]) + "\n..."


if CONFIG.language == "zh":
    LOG.info(f"User profiles: \n{get_prompt()}")

if __name__ == "__main__":
    from .profile_init_utils import export_user_profile_to_yaml

    # print(get_prompt())
    print(export_user_profile_to_yaml(CANDIDATE_PROFILE_TOPICS))
