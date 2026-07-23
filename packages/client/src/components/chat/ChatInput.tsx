import { FaArrowUp } from 'react-icons/fa';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { useForm } from 'react-hook-form';

export type ChatFormData = {
   prompt: string;
};

type Props = {
   onSubmit: (data: ChatFormData) => void;
   disabled?: boolean;
};

export const ChatInput = ({ onSubmit, disabled = false }: Props) => {
   const { register, handleSubmit, reset, formState } = useForm<ChatFormData>();

   const submit = handleSubmit((data) => {
      reset({ prompt: '' });
      onSubmit(data);
   });

   const handleKeyDown = (e: React.KeyboardEvent<HTMLFormElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
         e.preventDefault();
         if (!disabled) submit();
      }
   };
   return (
      <form
         onSubmit={submit}
         onKeyDown={handleKeyDown}
         className="flex flex-col gap-2 items-end border border-border bg-card p-4 rounded-3xl w-full max-w-4xl"
      >
         <Textarea
            autoFocus
            {...register('prompt', {
               required: true,
               validate: (data) => data.trim().length > 0,
            })}
            disabled={disabled}
            className="w-full border-0 shadow-none focus-visible:ring-0 resize-none"
            placeholder="Ask anything..."
            maxLength={1000}
         />
         <Button
            disabled={!formState.isValid || disabled}
            type="submit"
            className="rounded-full w-9 h-9"
         >
            <FaArrowUp />
         </Button>
      </form>
   );
};

