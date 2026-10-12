# Modified for Memoia: relocated from the upstream memobase_server package.
from ..env import CONFIG, LOG
from .profile_init_utils import (
    UserProfileTopic,
    formate_profile_topic,
    modify_default_user_profile,
)


# Identifiers are shared across languages; only descriptions and derived prose vary.
DEFAULT_TOPICS = [
    ("user_profile",
     "Brief overview of the user's important stable identity, life context and long-term priorities; not a copy of every detailed profile or another person's biography.",
     "用户本人的简短长期概况：重要稳定身份、生活背景及长期重点；不拼接所有详细画像，不写成他人的传记。"),
    ("personal_background",
     "The user's basic identity, residence and family background, only as supported and relevant; do not solicit or infer sensitive fields to complete a template.",
     "用户本人的基本身份、居住和家庭背景，只保留有依据且相关的信息；不为填模板主动补全或推断敏感字段。"),
    ("work", "The user's occupation, working environment, skills and sustained projects.",
     "用户本人的职业、工作环境、技能和持续项目。"),
    ("education", "The user's educational history and learning background.",
     "用户本人的教育经历和学习背景。"),
    ("interests_preferences", "The user's stable interests, tastes, activities and preferences. Use sub_topic=interaction_preferences for explicitly expressed lasting conversation preferences; exclude one-off instructions, temporary mood and assistant guesses. Keep other preferences in meaningful subtopics.",
     "用户本人的稳定兴趣、口味、活动及偏好。明确表达的长期交流偏好使用二级分类 interaction_preferences；不包含一次性指示、短期情绪或助手推测，其它偏好保留有意义的二级分类。"),
    ("lifestyle", "The user's sustained daily habits, routines and lifestyle; a single episode is not a habit.",
     "用户本人的持续日常习惯、作息及生活方式；一次经历不等于习惯。"),
    ("goals_values", "The user's long-term goals and explicitly expressed values and trade-offs; do not infer personality labels.",
     "用户本人的长期目标、明确表达的价值观与取舍；不推断人格标签。"),
    ("relationships", "Evidence-backed relatives, friends and colleagues and their attributes; distinguish subjects and do not merge uncertain identities.",
     "有证据的家人、朋友、同事及其背景；明确区分事实主体，不合并身份不确定的人物。"),
]


def default_profile_topics(language: str) -> list[UserProfileTopic]:
    return [UserProfileTopic(topic, description=zh if language == "zh" else en, sub_topics=[])
            for topic, en, zh in DEFAULT_TOPICS]


CANDIDATE_PROFILE_TOPICS = modify_default_user_profile(default_profile_topics("en"))


def get_prompt(profiles: list[UserProfileTopic] = CANDIDATE_PROFILE_TOPICS):
    return "\n".join([formate_profile_topic(up) for up in profiles]) + "\n..."


if CONFIG.language == "en":
    LOG.info(f"User profiles: \n{get_prompt()}")

if __name__ == "__main__":
    print(get_prompt())
